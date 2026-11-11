import { afterEach, describe, expect, it, vi } from "vitest"
import { findVulnerabilities } from "./osv.ts"
import { Ecosystem, lockfileFormatFor, manifestFormatFor } from "./packages.ts"

describe("manifest parsing", () => {
  it.each([
    ["package.json", '{"dependencies":{"left-pad":"^1.3.0"},"devDependencies":{"vitest":"^5.0.0"}}', [["left-pad", "^1.3.0"], ["vitest", "^5.0.0"]]],
    ["crates/x/Cargo.toml", '[dependencies]\nserde = "1"\ntokio = { version = "1.40", features = ["full"] }\n[dev-dependencies]\ninsta = "1"\n', [["serde", "1"], ["tokio", "1.40"], ["insta", "1"]]],
    ["pyproject.toml", '[project]\ndependencies = ["Requests[socks]>=2.31", "pydantic"]\n', [["requests", ">=2.31"], ["pydantic", "*"]]],
    ["requirements-dev.txt", "# tools\n-r requirements.txt\nblack==24.8.0\nruff>=0.6 ; python_version > '3.9'\n", [["black", "==24.8.0"], ["ruff", ">=0.6"]]],
  ])("reads declared dependencies from %s", (path, text, expected) => {
    expect([...(manifestFormatFor(path)?.parse(text) ?? [])]).toEqual(expected)
  })
})

describe("lockfile parsing", () => {
  it("reads exact versions from package-lock.json, including nested installs", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { "": { name: "app" }, "node_modules/lodash": { version: "4.17.20" }, "node_modules/a/node_modules/@scope/b": { version: "2.0.0" } },
    })
    expect(lockfileFormatFor("package-lock.json")?.parse(lock)).toEqual([
      { ecosystem: Ecosystem.Npm, name: "lodash", version: "4.17.20" },
      { ecosystem: Ecosystem.Npm, name: "@scope/b", version: "2.0.0" },
    ])
  })

  it("reads Cargo.lock and normalizes Python names in uv.lock", () => {
    expect(lockfileFormatFor("Cargo.lock")?.parse('[[package]]\nname = "time"\nversion = "0.1.45"\n')).toEqual([
      { ecosystem: Ecosystem.Crates, name: "time", version: "0.1.45" },
    ])
    expect(lockfileFormatFor("uv.lock")?.parse('[[package]]\nname = "PyYAML"\nversion = "5.3"\n')).toEqual([
      { ecosystem: Ecosystem.PyPI, name: "pyyaml", version: "5.3" },
    ])
  })
})

const GO_MOD = `module example.com/app

go 1.22

require github.com/spf13/cobra v1.8.0

require (
	github.com/stretchr/testify v1.9.0
	golang.org/x/text v0.3.7 // indirect
	example.com/shared v0.0.0-00010101000000-000000000000
	github.com/old/lib v1.0.0 // pinned for now
)

replace example.com/shared => ../shared

replace github.com/old/lib v1.0.0 => github.com/fork/lib v1.0.1
`

const POM = `<project>
  <groupId>com.acme</groupId>
  <artifactId>app</artifactId>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.0</version></parent>
  <properties><jackson.version>2.17.1</jackson.version></properties>
  <dependencyManagement><dependencies><dependency><groupId>com.managed</groupId><artifactId>bom</artifactId><version>1</version></dependency></dependencies></dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>\${jackson.version}</version>
      <exclusions><exclusion><groupId>org.excluded</groupId><artifactId>gone</artifactId></exclusion></exclusions>
    </dependency>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>com.acme</groupId><artifactId>shared</artifactId><version>\${project.version}</version></dependency>
    <dependency><groupId>com.acme</groupId><artifactId>published-client</artifactId><version>2.0.0</version></dependency>
    <dependency><groupId>org.ranged</groupId><artifactId>lib</artifactId><version>[1.0,2.0)</version></dependency>
    <!-- <dependency><groupId>org.commented</groupId><artifactId>out</artifactId></dependency> -->
  </dependencies>
  <build><plugins><plugin><artifactId>maven-x</artifactId><dependencies><dependency><groupId>org.plugin</groupId><artifactId>only</artifactId><version>1</version></dependency></dependencies></plugin></plugins></build>
</project>
`

const GRADLE_BUILD = `plugins { id("org.jetbrains.kotlin.jvm") version "2.0.0" }
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation(platform("org.springframework.boot:spring-boot-dependencies:3.3.0"))
    testImplementation 'org.junit.jupiter:junit-jupiter:5.10.2'
    api group: "org.slf4j", name: "slf4j-api", version: "2.0.13"
    runtimeOnly("com.h2database:h2:2.+")
    kapt("com.google.dagger:dagger-compiler:$daggerVersion")
    implementation("com.example:no-version")
    implementation(libs.guava)
}
tasks.test { systemProperty("mode:fast", "true") }
`

const CATALOG = `[versions]
guava = "33.2.1-jre"
kotlin = { strictly = "2.0.0" }

[libraries]
guava = { module = "com.google.guava:guava", version.ref = "guava" }
kotlin-stdlib = { group = "org.jetbrains.kotlin", name = "kotlin-stdlib", version.ref = "kotlin" }
okio = "com.squareup.okio:okio:3.9.0"
bom = { module = "io.micronaut:micronaut-bom" }
`

describe("Go and Java manifests", () => {
  it("reads go.mod's direct requirements, marking a module replaced by a directory as local", () => {
    expect([...(manifestFormatFor("go.mod")?.parse(GO_MOD) ?? [])]).toEqual([
      ["github.com/spf13/cobra", "v1.8.0"],
      ["github.com/stretchr/testify", "v1.9.0"],
      ["example.com/shared", "path:../shared"],
      ["github.com/old/lib", "v1.0.0"],
    ])
  })

  it("reads every module version go.mod selects, with replacements applied", () => {
    expect(lockfileFormatFor("svc/go.mod")?.parse(GO_MOD).map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      "github.com/spf13/cobra@v1.8.0",
      "github.com/stretchr/testify@v1.9.0",
      "golang.org/x/text@v0.3.7",
      "github.com/fork/lib@v1.0.1",
    ])
  })

  it("reads a pom's own dependencies, resolving properties and leaving out managed, plugin, excluded and commented ones", () => {
    expect([...(manifestFormatFor("pom.xml")?.parse(POM) ?? [])]).toEqual([
      ["com.fasterxml.jackson.core:jackson-databind", "2.17.1"],
      ["org.springframework.boot:spring-boot-starter-web", "*"],
      ["com.acme:shared", "workspace:"],
      ["com.acme:published-client", "2.0.0"],
      ["org.ranged:lib", "[1.0,2.0)"],
    ])
  })

  it.each([
    ["spliced", "<!<!-- x -->-- <dependency><groupId>org.hidden</groupId><artifactId>spliced</artifactId></dependency> -->"],
    ["unclosed", "<!-- <dependency><groupId>org.hidden</groupId><artifactId>unclosed</artifactId></dependency>"],
    ["repeated", "<!-- a --><!-- <dependency><groupId>org.hidden</groupId><artifactId>second</artifactId></dependency> -->"],
  ])("reads nothing inside a %s comment", (_kind, comment) => {
    const pom = `<project><dependencies>${comment}<dependency><groupId>org.kept</groupId><artifactId>kept</artifactId><version>1</version></dependency></dependencies></project>`
    const declared = [...(manifestFormatFor("pom.xml")?.parse(pom) ?? [])]
    expect(declared).toEqual(comment.includes("unclosed") ? [] : [["org.kept:kept", "1"]])
  })

  it("checks only exact pom versions, and not the project's own modules", () => {
    expect(lockfileFormatFor("api/pom.xml")?.parse(POM)).toEqual([
      { ecosystem: Ecosystem.Maven, name: "com.fasterxml.jackson.core:jackson-databind", version: "2.17.1" },
      { ecosystem: Ecosystem.Maven, name: "com.acme:published-client", version: "2.0.0" },
    ])
  })

  it.each(["build.gradle", "app/build.gradle.kts"])("reads coordinates in %s's dependency configurations", (path) => {
    expect([...(manifestFormatFor(path)?.parse(GRADLE_BUILD) ?? [])]).toEqual([
      ["com.squareup.okhttp3:okhttp", "4.12.0"],
      ["org.springframework.boot:spring-boot-dependencies", "3.3.0"],
      ["org.junit.jupiter:junit-jupiter", "5.10.2"],
      ["com.h2database:h2", "2.+"],
      ["com.google.dagger:dagger-compiler", "$daggerVersion"],
      ["com.example:no-version", "*"],
      ["org.slf4j:slf4j-api", "2.0.13"],
    ])
    expect(lockfileFormatFor(path)?.parse(GRADLE_BUILD).map((entry) => entry.name)).toEqual([
      "com.squareup.okhttp3:okhttp",
      "org.springframework.boot:spring-boot-dependencies",
      "org.junit.jupiter:junit-jupiter",
      "org.slf4j:slf4j-api",
    ])
  })

  it("reads a Gradle version catalog, following version references", () => {
    expect([...(manifestFormatFor("gradle/libs.versions.toml")?.parse(CATALOG) ?? [])]).toEqual([
      ["com.google.guava:guava", "33.2.1-jre"],
      ["org.jetbrains.kotlin:kotlin-stdlib", "2.0.0"],
      ["com.squareup.okio:okio", "3.9.0"],
      ["io.micronaut:micronaut-bom", "*"],
    ])
  })

  it("reads gradle.lockfile", () => {
    const lock = "# This is a Gradle generated file\ncom.google.guava:guava:33.2.1-jre=compileClasspath,runtimeClasspath\nempty=annotationProcessor\n"
    expect(lockfileFormatFor("gradle.lockfile")?.parse(lock)).toEqual([{ ecosystem: Ecosystem.Maven, name: "com.google.guava:guava", version: "33.2.1-jre" }])
  })
})

describe("findVulnerabilities", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("queries OSV in a batch and reads severity and the fixed version", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/querybatch")) {
        return Response.json({ results: [{ vulns: [{ id: "GHSA-1234" }] }, {}] })
      }
      return Response.json({
        id: "GHSA-1234",
        summary: "Prototype pollution",
        aliases: ["CVE-2020-8203"],
        database_specific: { severity: "HIGH" },
        affected: [{ package: { name: "lodash", ecosystem: "npm" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    const found = await findVulnerabilities([
      { ecosystem: Ecosystem.Npm, name: "lodash", version: "4.17.20" },
      { ecosystem: Ecosystem.Npm, name: "safe", version: "1.0.0" },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(found).toEqual([
      {
        package: { ecosystem: "npm", name: "lodash", version: "4.17.20" },
        vulnerability: { id: "GHSA-1234", aliases: ["CVE-2020-8203"], summary: "Prototype pollution", severity: "high", fixedIn: "4.17.21" },
      },
    ])
  })
})
