import { basename, extname } from "node:path"
import { FileChangeStatus, isTestPath, RiskCategory, RiskSeverity } from "@walkdiff/review-model"
import type { Risk } from "@walkdiff/review-model"
import { addedLines, findingAt, isThirdParty } from "./scannedFile.ts"
import type { AddedLine, RuleDescription, ScannedFile } from "./scannedFile.ts"

/**
 * Misconfigurations in infrastructure code that a PR adds: Dockerfiles, Kubernetes manifests and
 * Terraform. These files aren't parsed, so each rule reads one added line, skips comment lines, and
 * looks at the rest of the file only where a line alone can't tell (a Terraform block's direction,
 * a Dockerfile's build stages).
 */

function rule(id: string, severity: RiskSeverity, title: string, detail: string): RuleDescription {
  return { id, category: RiskCategory.Infrastructure, severity, title, detail }
}

/** One added line's problem, given the whole file for context. */
interface LineRule {
  readonly rule: RuleDescription
  readonly matches: (line: AddedLine, file: FileContext) => boolean
}

interface FileContext {
  readonly lines: readonly string[]
  /** Dockerfile stage names (`FROM … AS builder`), which a later `FROM builder` refers to. */
  readonly stages: ReadonlySet<string>
}

/** A kind of infrastructure file, the comment marker it uses, and its rules. */
interface InfrastructureFormat {
  readonly name: string
  readonly matches: (path: string, text: string) => boolean
  readonly comment: RegExp
  readonly lineRules: readonly LineRule[]
  /** Problems with the file as a whole, such as a new Dockerfile that never leaves root. */
  readonly fileRules?: (file: ScannedFile, context: FileContext) => Risk[]
}

const UNPINNED_IMAGE_DETAIL = "Each build can pull a different image, so a broken or compromised release arrives unseen. Pin a version tag, or a digest for the strongest guarantee."

const DOCKER_UNPINNED_BASE = rule("docker.base-unpinned", RiskSeverity.Low, "Base image without a version", UNPINNED_IMAGE_DETAIL)
const DOCKER_PIPE_TO_SHELL = rule("docker.pipe-to-shell", RiskSeverity.Medium, "Runs a script straight from the internet", "Whatever the server returns runs in the build, and nothing checks it. Download it, check its checksum, then run it.")
const DOCKER_ADD_URL = rule("docker.add-url", RiskSeverity.Low, "ADD fetches a URL", "The file isn't checked, so a changed download goes into the image unseen. Use ADD --checksum, or download and verify it in a RUN step.")
const DOCKER_SECRET_IN_IMAGE = rule("docker.secret-in-image", RiskSeverity.Medium, "Secret in a build argument or environment variable", "ARG and ENV values are kept in the image's history, where anyone who can pull it can read them. Use a build secret (RUN --mount=type=secret) instead.")
const DOCKER_ROOT = rule("docker.runs-as-root", RiskSeverity.Low, "Container runs as root", "A process that breaks out of the application has root inside the container, which makes escaping it easier. Add a USER with an unprivileged account.")

const K8S_PRIVILEGED = rule("k8s.privileged", RiskSeverity.High, "Privileged container", "It has nearly every capability of the host, so anyone who controls it controls the node. Grant only the capabilities it needs.")
const K8S_HOST_NAMESPACE = rule("k8s.host-namespace", RiskSeverity.High, "Shares the host's network, processes or IPC", "The pod sees and can reach what the node does, outside the isolation pods normally get. Remove it unless it's a node-level agent that needs it.")
const K8S_ESCALATION = rule("k8s.privilege-escalation", RiskSeverity.Medium, "Allows privilege escalation", "A process can gain more privileges than its parent, such as through a setuid binary. Set allowPrivilegeEscalation: false.")
const K8S_ROOT = rule("k8s.runs-as-root", RiskSeverity.Medium, "Runs as root", "A process that breaks out of the application has root inside the container. Run as a non-root user.")
const K8S_HOST_PATH = rule("k8s.host-path", RiskSeverity.Medium, "Mounts a folder from the node", "The pod can read, and often write, files on the node itself. Use a volume type that keeps it inside its own storage.")
const K8S_CAPABILITIES = rule("k8s.dangerous-capability", RiskSeverity.Medium, "Adds a powerful Linux capability", "SYS_ADMIN, NET_ADMIN and ALL each give the container control over parts of the node. Add only what it needs.")
const K8S_UNPINNED_IMAGE = rule("k8s.image-unpinned", RiskSeverity.Low, "Container image without a version", UNPINNED_IMAGE_DETAIL)

const TF_OPEN_INGRESS = rule("terraform.open-ingress", RiskSeverity.Medium, "Open to the whole internet", "Inbound traffic is allowed from any address. Narrow it to the addresses that need it, or put the service behind a load balancer.")
const TF_PUBLIC_BUCKET = rule("terraform.public-bucket", RiskSeverity.High, "Public storage bucket", "Anyone on the internet can read, and with public-read-write also write, what's in it. Keep buckets private and share through signed URLs or a CDN.")
const TF_PUBLIC_ACCESS_UNBLOCKED = rule("terraform.public-access-allowed", RiskSeverity.Medium, "Public access protection turned off", "This turns off the safeguard that stops a bucket, or anything in it, from being made public by mistake.")
const TF_PUBLIC_DATABASE = rule("terraform.public-database", RiskSeverity.High, "Database reachable from the internet", "The database gets a public address. Keep it in private subnets and connect through the application or a bastion.")
const TF_UNENCRYPTED = rule("terraform.encryption-off", RiskSeverity.Medium, "Encryption turned off", "Data is stored unencrypted. Encryption at rest costs little and is often required.")
const TF_WILDCARD_ACTION = rule("terraform.iam-wildcard", RiskSeverity.Medium, "Grants every action", "A policy allowing every action gives far more than any role needs, including changing its own permissions. List the actions it uses.")

const DOCKERFILE_NAME = /^(?:Dockerfile|Containerfile)(?:\.[\w.-]+)?$|\.(?:dockerfile|containerfile)$/i
const YAML_EXTENSIONS: ReadonlySet<string> = new Set([".yaml", ".yml"])
const KUBERNETES_KIND = /^\s*kind:\s*\w+/m
const KUBERNETES_API_VERSION = /^\s*apiVersion:\s*\S+/m
const TERRAFORM_EXTENSION = ".tf"

const FROM_INSTRUCTION = /^\s*FROM\s+(?:--platform=\S+\s+)?(?<image>\S+)(?:\s+AS\s+(?<stage>\S+))?/i
const IMAGE_PINNED = /(?::[\w][\w.-]*|@sha256:[0-9a-f]{64})$/
const LATEST_TAG = /:latest$/
const SCRATCH_IMAGE = "scratch"
// Template variables such as `${BASE_IMAGE}` are chosen elsewhere, so their version isn't knowable here.
const TEMPLATED = /[$]\{|\{\{/
const USER_INSTRUCTION = /^\s*USER\s+(?<user>\S+)/i
const ROOT_USERS: ReadonlySet<string> = new Set(["root", "0", "0:0", "root:root"])
const SECRET_NAME = /^\s*(?:ARG|ENV)\s+\w*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)\w*/i
const DANGEROUS_CAPABILITY = /^["']?(?:CAP_)?(?:SYS_ADMIN|NET_ADMIN|ALL)["']?$/
const INLINE_ADD = /^\s*add:\s*\[(?<list>[^\]]*)\]/
const LIST_ITEM = /^\s*-\s*(?<item>\S+)\s*$/
const CAPABILITY_KEY = /^\s*(?<key>add|drop):\s*$/
const ADD_KEY = "add"
const K8S_IMAGE = /^\s*-?\s*image:\s*["']?(?<image>[^\s"']+)["']?\s*$/
const TF_DIRECTION = /^\s*(?<block>ingress|egress)\s*\{|type\s*=\s*"(?<type>ingress|egress)"|aws_vpc_security_group_(?<resource>ingress|egress)_rule/
const INGRESS = "ingress"
const OPEN_CIDR = /"0\.0\.0\.0\/0"|"::\/0"/

const DOCKERFILE: InfrastructureFormat = {
  name: "Dockerfile",
  matches: (path) => DOCKERFILE_NAME.test(basename(path)),
  comment: /^\s*#/,
  lineRules: [
    { rule: DOCKER_UNPINNED_BASE, matches: ({ content }, file) => isUnpinnedBase(content, file.stages) },
    { rule: DOCKER_PIPE_TO_SHELL, matches: ({ content }) => /\b(?:curl|wget)\b[^|#]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(content) },
    { rule: DOCKER_ADD_URL, matches: ({ content }) => /^\s*ADD\s+(?!--checksum)(?:--\S+\s+)*https?:\/\//i.test(content) },
    { rule: DOCKER_SECRET_IN_IMAGE, matches: ({ content }) => SECRET_NAME.test(content) },
    { rule: DOCKER_ROOT, matches: ({ content }) => ROOT_USERS.has(USER_INSTRUCTION.exec(content)?.groups?.user?.toLowerCase() ?? "") },
  ],
  fileRules: newDockerfileWithoutUser,
}

const KUBERNETES: InfrastructureFormat = {
  name: "Kubernetes manifest",
  matches: (path, text) => YAML_EXTENSIONS.has(extname(path).toLowerCase()) && KUBERNETES_KIND.test(text) && KUBERNETES_API_VERSION.test(text),
  comment: /^\s*#/,
  lineRules: [
    { rule: K8S_PRIVILEGED, matches: ({ content }) => /^\s*privileged:\s*true\b/.test(content) },
    { rule: K8S_HOST_NAMESPACE, matches: ({ content }) => /^\s*host(?:Network|PID|IPC):\s*true\b/.test(content) },
    { rule: K8S_ESCALATION, matches: ({ content }) => /^\s*allowPrivilegeEscalation:\s*true\b/.test(content) },
    { rule: K8S_ROOT, matches: ({ content }) => /^\s*runAsUser:\s*0\s*$|^\s*runAsNonRoot:\s*false\b/.test(content) },
    { rule: K8S_HOST_PATH, matches: ({ content }) => /^\s*-?\s*hostPath:/.test(content) },
    { rule: K8S_CAPABILITIES, matches: ({ content, line }, file) => addsDangerousCapability(content, file.lines, line) },
    { rule: K8S_UNPINNED_IMAGE, matches: ({ content }) => isUnpinnedImage(K8S_IMAGE.exec(content)?.groups?.image) },
  ],
}

const TERRAFORM: InfrastructureFormat = {
  name: "Terraform",
  matches: (path) => extname(path).toLowerCase() === TERRAFORM_EXTENSION,
  comment: /^\s*(?:#|\/\/)/,
  lineRules: [
    { rule: TF_OPEN_INGRESS, matches: ({ content, line }, file) => OPEN_CIDR.test(content) && directionAbove(file.lines, line) === INGRESS },
    { rule: TF_PUBLIC_BUCKET, matches: ({ content }) => /\bacl\s*=\s*"public-read(?:-write)?"/.test(content) },
    { rule: TF_PUBLIC_ACCESS_UNBLOCKED, matches: ({ content }) => /\b(?:block_public_acls|block_public_policy|ignore_public_acls|restrict_public_buckets)\s*=\s*false\b/.test(content) },
    { rule: TF_PUBLIC_DATABASE, matches: ({ content }) => /\bpublicly_accessible\s*=\s*true\b/.test(content) },
    { rule: TF_UNENCRYPTED, matches: ({ content }) => /\b(?:encrypted|storage_encrypted|encrypt_at_rest|enable_encryption)\s*=\s*false\b/.test(content) },
    { rule: TF_WILDCARD_ACTION, matches: ({ content }) => /["']?Action["']?\s*[:=]\s*(?:\[\s*)?"\*"|\bactions\s*=\s*\[\s*"\*"\s*\]/.test(content) },
  ],
}

const FORMATS: readonly InfrastructureFormat[] = [DOCKERFILE, KUBERNETES, TERRAFORM]

export function scanInfrastructure(files: readonly ScannedFile[]): Risk[] {
  return files.flatMap((file) => {
    const text = file.after
    if (text === undefined || isThirdParty(file) || isTestPath(file.diff.path)) return []
    const format = FORMATS.find((candidate) => candidate.matches(file.diff.path, text))
    if (format === undefined) return []
    const context = contextOf(text)
    const fromLines = addedLines(file.diff)
      .filter((line) => !format.comment.test(line.content))
      .flatMap((line) => format.lineRules.filter((lineRule) => lineRule.matches(line, context)).map((lineRule) => findingAt(lineRule.rule, file.diff.path, line.line, line.content)))
    return [...fromLines, ...(format.fileRules?.(file, context) ?? [])]
  })
}

function contextOf(text: string): FileContext {
  const lines = text.split("\n")
  const stages = new Set(lines.flatMap((line) => FROM_INSTRUCTION.exec(line)?.groups?.stage?.toLowerCase() ?? []))
  return { lines, stages }
}

function isUnpinnedBase(content: string, stages: ReadonlySet<string>): boolean {
  const image = FROM_INSTRUCTION.exec(content)?.groups?.image
  if (image === undefined || image.toLowerCase() === SCRATCH_IMAGE || stages.has(image.toLowerCase())) return false
  return isUnpinnedImage(image)
}

function isUnpinnedImage(image: string | undefined): boolean {
  if (image === undefined || TEMPLATED.test(image)) return false
  return !IMAGE_PINNED.test(image) || LATEST_TAG.test(image)
}

// `add: ["SYS_ADMIN"]`, or a `- SYS_ADMIN` item under `add:`. `- ALL` under `drop:` is good practice.
function addsDangerousCapability(content: string, lines: readonly string[], line: number): boolean {
  const inline = INLINE_ADD.exec(content)?.groups?.list
  if (inline !== undefined) return inline.split(",").some((item) => DANGEROUS_CAPABILITY.test(item.trim()))
  const item = LIST_ITEM.exec(content)?.groups?.item
  if (item === undefined || !DANGEROUS_CAPABILITY.test(item)) return false
  for (let row = line - 2; row >= 0; row--) {
    const key = CAPABILITY_KEY.exec(lines.at(row) ?? "")?.groups?.key
    if (key !== undefined) return key === ADD_KEY
    if (!LIST_ITEM.test(lines.at(row) ?? "")) return false
  }
  return false
}

// The nearest `ingress {` or `egress {` block, or ingress or egress rule resource, above the line.
function directionAbove(lines: readonly string[], line: number): string | undefined {
  for (let row = line - 1; row >= 0; row--) {
    const groups = TF_DIRECTION.exec(lines.at(row) ?? "")?.groups
    const direction = groups?.block ?? groups?.type ?? groups?.resource
    if (direction !== undefined) return direction
  }
  return undefined
}

// Only a Dockerfile the PR adds: one that already ran as root isn't this PR's change.
function newDockerfileWithoutUser(file: ScannedFile, context: FileContext): Risk[] {
  if (file.diff.status !== FileChangeStatus.Added) return []
  const lastFrom = context.lines.findLastIndex((line) => FROM_INSTRUCTION.test(line))
  if (lastFrom === -1) return []
  const setsUser = context.lines.slice(lastFrom).some((line) => USER_INSTRUCTION.test(line))
  return setsUser ? [] : [findingAt(DOCKER_ROOT, file.diff.path, lastFrom + 1, context.lines.at(lastFrom) ?? null)]
}
