import type { DiffLine, FileDiff, Risk } from "@walkdiff/review-model"
import { describe, expect, it } from "vitest"
import { scanInfrastructure } from "./infrastructure.ts"
import type { ScannedFile } from "./scannedFile.ts"

/** The file at head, where lines marked with a leading `+` are the ones the PR adds. */
function changedFile(path: string, marked: string, status: "added" | "modified" = "modified"): ScannedFile {
  const lines = marked.split("\n")
  const diffLines = lines.map((line, index): DiffLine =>
    line.startsWith("+") ? { kind: "added", content: line.slice(1), newLine: index + 1 } : { kind: "context", content: line, oldLine: index + 1, newLine: index + 1 },
  )
  const diff: FileDiff = {
    status,
    path,
    additions: lines.filter((line) => line.startsWith("+")).length,
    deletions: 0,
    content: { kind: "text", hunks: [{ oldStart: 1, oldLines: lines.length, newStart: 1, newLines: lines.length, section: "", lines: diffLines }] },
  }
  return { diff, noise: null, after: lines.map((line) => (line.startsWith("+") ? line.slice(1) : line)).join("\n") }
}

function summary(findings: readonly Risk[]): string[] {
  return findings.map((finding) => `${finding.ruleId}@${finding.location?.line ?? "-"}`)
}

describe("Dockerfiles", () => {
  it("flags unpinned bases, piped scripts, fetched URLs, secrets in the image and root", async () => {
    const file = changedFile("Dockerfile", [
      "+FROM node AS build",
      "+RUN curl -fsSL https://get.example.sh | sh",
      "+ADD https://example.com/tool.tar.gz /opt/",
      "+ARG NPM_TOKEN",
      "+FROM build",
      "+FROM python:latest",
      "+USER root",
    ].join("\n"))
    expect(summary(scanInfrastructure([file]))).toEqual([
      "docker.base-unpinned@1",
      "docker.pipe-to-shell@2",
      "docker.add-url@3",
      "docker.secret-in-image@4",
      "docker.base-unpinned@6",
      "docker.runs-as-root@7",
    ])
  })

  it("leaves pinned images, scratch, its own stages, checksums and comments alone", async () => {
    const file = changedFile("services/api/Dockerfile", [
      "+FROM golang:1.25 AS build",
      "+FROM scratch",
      "+FROM build",
      "+FROM alpine@sha256:" + "a".repeat(64),
      "+FROM ${BASE_IMAGE}",
      "+ADD --checksum=sha256:abc https://example.com/a /a",
      "+# RUN curl https://example.com | sh",
      "+USER app",
    ].join("\n"))
    expect(scanInfrastructure([file])).toEqual([])
  })

  it("flags a new Dockerfile that never sets a user, but not an old one the PR edits", async () => {
    const fresh = changedFile("Dockerfile", "+FROM node:24\n+RUN npm ci", "added")
    const edited = changedFile("Dockerfile.dev", "FROM node:24\n+RUN npm ci")
    expect(summary(scanInfrastructure([fresh, edited]))).toEqual(["docker.runs-as-root@1"])
  })
})

describe("Kubernetes manifests", () => {
  const manifest = (body: string): ScannedFile => changedFile("deploy/api.yaml", `apiVersion: apps/v1\nkind: Deployment\nspec:\n${body}`)

  it("flags privileged and root containers, host access, added capabilities and unpinned images", async () => {
    const file = manifest([
      "+      hostNetwork: true",
      "+      containers:",
      "+        - image: nginx",
      "+          securityContext:",
      "+            privileged: true",
      "+            allowPrivilegeEscalation: true",
      "+            runAsUser: 0",
      "+            capabilities:",
      "+              add:",
      "+                - SYS_ADMIN",
      "+      volumes:",
      "+        - hostPath:",
    ].join("\n"))
    expect(summary(scanInfrastructure([file]))).toEqual([
      "k8s.host-namespace@4",
      "k8s.image-unpinned@6",
      "k8s.privileged@8",
      "k8s.privilege-escalation@9",
      "k8s.runs-as-root@10",
      "k8s.dangerous-capability@13",
      "k8s.host-path@15",
    ])
  })

  it("leaves dropped capabilities, pinned images, safe settings and other YAML alone", async () => {
    const file = manifest([
      "+        - image: ghcr.io/acme/api:1.4.2",
      "+          securityContext:",
      "+            runAsNonRoot: true",
      "+            allowPrivilegeEscalation: false",
      "+            capabilities:",
      "+              drop:",
      "+                - ALL",
    ].join("\n"))
    const notKubernetes = changedFile("config/app.yaml", "+privileged: true")
    expect(scanInfrastructure([file, notKubernetes])).toEqual([])
  })
})

describe("Terraform", () => {
  it("flags open ingress, public buckets and databases, encryption off and wildcard actions", async () => {
    const file = changedFile("infra/main.tf", [
      'resource "aws_security_group" "web" {',
      "  ingress {",
      '+    cidr_blocks = ["0.0.0.0/0"]',
      "  }",
      "  egress {",
      '+    cidr_blocks = ["0.0.0.0/0"]',
      "  }",
      "}",
      '+resource "aws_s3_bucket_acl" "a" { acl = "public-read" }',
      "+  block_public_acls = false",
      "+  publicly_accessible = true",
      "+  storage_encrypted = false",
      '+      Action = "*"',
    ].join("\n"))
    expect(summary(scanInfrastructure([file]))).toEqual([
      "terraform.open-ingress@3",
      "terraform.public-bucket@9",
      "terraform.public-access-allowed@10",
      "terraform.public-database@11",
      "terraform.encryption-off@12",
      "terraform.iam-wildcard@13",
    ])
  })

  it("ignores comments and test fixtures", async () => {
    const commented = changedFile("infra/a.tf", '+# acl = "public-read"\n+// publicly_accessible = true')
    const fixture = changedFile("tests/fixtures/open.tf", "+  publicly_accessible = true")
    expect(scanInfrastructure([commented, fixture])).toEqual([])
  })
})
