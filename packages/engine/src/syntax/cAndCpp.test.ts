import { describe, expect, it } from "vitest"
import { findIdentifierUses } from "../impact/identifierUses.ts"
import { cppSpec, cSpec } from "./cFamily.ts"
import { compareUnits } from "./compareUnits.ts"
import { extractUnits } from "./definitions.ts"
import type { Definition, FileUnits } from "./definitions.ts"
import type { LanguageSpec } from "./languageSpec.ts"
import { canReferenceAcross, languageSpecFor } from "./languages.ts"
import { withSyntaxTree } from "./parser.ts"

function unitsOf(spec: LanguageSpec, source: string): Promise<FileUnits> {
  return withSyntaxTree(spec, source, (tree) => extractUnits(spec, tree, source))
}

async function outline(spec: LanguageSpec, source: string): Promise<string[]> {
  const units = await unitsOf(spec, source)
  return units.definitions.map((definition) => `${definition.kind} ${definition.qualifiedName}${definition.isPublic ? " (public)" : ""}`)
}

async function unitNamed(spec: LanguageSpec, source: string, qualifiedName: string): Promise<Definition> {
  const found = (await unitsOf(spec, source)).definitions.find((definition) => definition.qualifiedName === qualifiedName)
  if (found === undefined) throw new Error(`no unit ${qualifiedName}`)
  return found
}

function usesOf(spec: LanguageSpec, source: string, name: string): Promise<string[]> {
  return withSyntaxTree(spec, source, (tree) =>
    findIdentifierUses(spec, tree, new Set([name])).map((occurrence) => {
      const detail = "qualifier" in occurrence.use ? occurrence.use.qualifier : "receiver" in occurrence.use ? occurrence.use.receiver : ""
      return `${occurrence.line} ${occurrence.use.kind}${detail === "" ? "" : ` ${detail}`}`
    }),
  )
}

const C_SOURCE = `#ifndef STORE_H
#define STORE_H
#include <stdio.h>

#define LIMIT 10
#define MAX(a, b) ((a) > (b) ? (a) : (b))

static int counter = 0;
const char *store_name = "store";

/* A point. */
typedef struct point { int x; int y; } point_t;
struct node { struct node *next; };
enum color { RED, GREEN };
typedef int (*handler)(int);

int store_add(int a, int b, ...);

int store_add(int a, int b, ...) {
  if (a > 0 && b > 0) return a + b;
  for (int i = 0; i < b; i++) { a++; }
  return a ? b : 0;
}

static char *dup_name(const char *name) {
  if (name == NULL) exit(1);
  return strdup(name);
}

void (*on_signal(int sig, void (*handler)(int)))(int) { return handler; }

int no_args(void) { return 0; }
#endif
`

const CPP_SOURCE = `#include <string>

namespace net {
namespace {
int hidden() { return 1; }
}

template <typename T>
class Server : public Base {
 public:
  explicit Server(int port) : port_(port) {}
  ~Server();
  void start() const override;
  bool operator==(const Server& other) const { return port_ == other.port_; }
  friend void swap(Server& a, Server& b) {}

 private:
  int port_;
  struct Options { int retries; };
};

template <typename T>
void Server<T>::start() const {
  auto check = [this](int x) { return x + port_; };
  if (port_ < 0) throw std::runtime_error("bad port");
}

Server::~Server() {}

using Handler = std::function<void(int)>;
enum class Mode { kOn, kOff };

void serve(int a, const std::string& host, int* out = nullptr, Args&&... rest) {
  server.start();
  pool->submit(host);
  net::util::log(host);
  new Session(a);
}
}  // namespace net

extern "C" int c_api(void);
`

describe("C", () => {
  it("extracts macros, globals, types, prototypes and functions, leaving header guards in the file", async () => {
    expect(await outline(cSpec, C_SOURCE)).toEqual([
      "macro LIMIT (public)",
      "macro MAX (public)",
      "constant counter",
      "constant store_name (public)",
      "struct point_t (public)",
      "struct node (public)",
      "enum color (public)",
      "typeAlias handler (public)",
      "function store_add (public)",
      "function store_add (public)",
      "function dup_name",
      "function on_signal (public)",
      "function no_args (public)",
    ])
  })

  it("keeps a typedef's comment with it", async () => {
    const point = await unitNamed(cSpec, C_SOURCE, "point_t")
    expect(point.snapshot.text).toBe("/* A point. */\ntypedef struct point { int x; int y; } point_t;")
  })

  it("reads parameters through pointer and function declarators, variadics and exits", async () => {
    const add = (await unitsOf(cSpec, C_SOURCE)).definitions.filter((definition) => definition.name === "store_add").at(1)
    expect(add?.shape?.signature.map((parameter) => `${parameter.name}:${parameter.kind}:${parameter.type}`)).toEqual(["a:required:int", "b:required:int", "...:rest:null"])
    expect(add?.shape?.metrics.complexity).toBe(5)
    const dup = (await unitNamed(cSpec, C_SOURCE, "dup_name")).shape
    expect(dup?.signature.map((parameter) => parameter.name)).toEqual(["name"])
    expect([...(dup?.calls ?? [])]).toEqual(["exit", "strdup"])
    expect(dup?.errorPaths).toBe(1)
    const signal = (await unitNamed(cSpec, C_SOURCE, "on_signal")).shape
    expect(signal?.signature.map((parameter) => parameter.name)).toEqual(["sig", "handler"])
    expect((await unitNamed(cSpec, C_SOURCE, "no_args")).shape?.signature).toEqual([])
  })

  it("counts calls and pointer types as uses, but not declarations, parameters or locals", async () => {
    const source = [
      "int parse(const char *text);",
      "int parse(const char *text) { return 0; }",
      "struct parse *find(int key);",
      "int count(int parse) { return parse; }",
      "void run(void) { parse(\"x\"); table->parse(1); }",
    ].join("\n")
    expect(await usesOf(cSpec, source, "parse")).toEqual(["3 bare", "5 bare", "5 member table"])
  })

  it("is chosen for .c files", () => {
    expect(languageSpecFor("src/store.c")).toBe(cSpec)
  })
})

describe("C++", () => {
  it("extracts namespaces, classes and their members, and methods defined outside their class", async () => {
    expect(await outline(cppSpec, CPP_SOURCE)).toEqual([
      "module net (public)",
      "function net::hidden",
      "class net::Server (public)",
      "method net::Server::Server (public)",
      "method net::Server::~Server (public)",
      "method net::Server::start (public)",
      "method net::Server::operator== (public)",
      "struct net::Server::Options",
      "method net::Server::start (public)",
      "method net::Server::~Server (public)",
      "typeAlias net::Handler (public)",
      "enum net::Mode (public)",
      "function net::serve (public)",
      "function c_api (public)",
    ])
  })

  it("keeps a template's header with its definition", async () => {
    const server = await unitNamed(cppSpec, CPP_SOURCE, "net::Server")
    expect(server.snapshot.text.split("\n").at(0)).toBe("template <typename T>")
  })

  it("reads references, defaults, parameter packs, calls and throws", async () => {
    const serve = (await unitNamed(cppSpec, CPP_SOURCE, "net::serve")).shape
    expect(serve?.signature.map((parameter) => `${parameter.name}:${parameter.kind}`)).toEqual(["a:required", "host:required", "out:optional", "rest:rest"])
    expect([...(serve?.calls ?? [])]).toEqual(["server.start", "pool->submit", "net::util::log", "Session"])
    const start = (await unitsOf(cppSpec, CPP_SOURCE)).definitions.filter((definition) => definition.qualifiedName === "net::Server::start").at(1)
    expect(start?.shape?.errorPaths).toBe(1)
    expect(start?.shape?.metrics.complexity).toBe(2)
  })

  it("tells qualified and member calls from the definitions they name", async () => {
    const source = [
      "class Server { void start(); };",
      "void Server::start() {}",
      "void run(Server *server) { server->start(); Server::start(); this->start(); }",
    ].join("\n")
    expect(await usesOf(cppSpec, source, "start")).toEqual(["3 member server", "3 path Server", "3 member this"])
  })

  it("names a specialization by its first arguments", async () => {
    const source = [
      "template <typename T, typename Char>",
      "struct formatter<std::expected<T, E>, Char,",
      "                 std::enable_if_t<is_formattable<T, Char>::value && is_formattable<E, Char>::value>> {",
      "  auto format(const T& value) const { return value; }",
      "};",
      "template <> struct formatter<int> {};",
    ].join("\n")
    expect(await outline(cppSpec, source)).toEqual([
      "struct formatter<std::expected<T, E>, Char, …> (public)",
      "method formatter<std::expected<T, E>, Char, …>::format (public)",
      "struct formatter<int> (public)",
    ])
  })

  it("names test and other macro blocks by their whole call, and leaves a misread macro inside its method", async () => {
    const source = [
      "TEST(parser, reads_numbers) { EXPECT_EQ(parse(\"1\"), 1); }",
      "TEST_F(ServerTest, starts) {}",
      "BENCHMARK(parse_numbers) {}",
      "struct Writer {",
      "  void write() {",
      "    FMT_TRY { run(); }",
      "    FMT_CATCH(const std::exception&) { fail(); }",
      "  }",
      "};",
    ].join("\n")
    const units = await outline(cppSpec, source)
    expect(units.slice(0, 3)).toEqual(["test TEST(parser, reads_numbers) (public)", "test TEST_F(ServerTest, starts) (public)", "function BENCHMARK(parse_numbers) (public)"])
    expect(units).not.toContain("method Writer::FMT_CATCH (public)")
  })

  it.each(["include/net/server.h", "src/server.cc", "src/server.cpp", "src/server.hpp"])("is chosen for %s", (path) => {
    expect(languageSpecFor(path)).toBe(cppSpec)
  })

  it("can refer to C and be referred to from it", () => {
    expect(canReferenceAcross(cSpec.language, cppSpec.language)).toBe(true)
  })

  it("reports a method changed outside its class under its full name", async () => {
    const before = "namespace net {\nvoid Server::start() { run(1); }\n}\n"
    const after = "namespace net {\nvoid Server::start() { run(2); }\n}\n"
    const result = compareUnits([{ path: "server.cc", before: await unitsOf(cppSpec, before), after: await unitsOf(cppSpec, after) }])
    expect(result.get("server.cc")?.map((unit) => `${unit.kind} ${unit.qualifiedName}: ${unit.change.kind}`)).toEqual(["method net::Server::start: modified"])
  })
})
