import { Ecosystem } from "./packages.ts"

/**
 * Widely used packages that attackers imitate, hand-picked rather than measured. A short list
 * means some lookalikes go unflagged, which is the safer failure: every name here can produce a
 * warning about a similarly named package, so it should only hold names worth imitating.
 */
export const POPULAR_PACKAGES: Readonly<Record<Ecosystem, ReadonlySet<string>>> = {
  [Ecosystem.Npm]: new Set([
    "react", "react-dom", "next", "express", "lodash", "axios", "typescript", "webpack", "vite", "eslint", "prettier", "jest", "vitest", "mocha", "chalk",
    "commander", "dotenv", "moment", "dayjs", "uuid", "async", "request", "debug", "glob", "minimist", "yargs", "semver", "mkdirp", "rimraf", "nodemon",
    "tslib", "zod", "redux", "angular", "svelte", "tailwindcss", "postcss", "babel-core", "cross-env", "body-parser", "cors", "mongoose", "sequelize", "prisma",
    "socket.io", "jsonwebtoken", "bcrypt", "bcryptjs", "passport", "nodemailer", "underscore", "bluebird", "cheerio", "puppeteer", "playwright", "electron",
    "esbuild", "rollup", "ts-node", "colors", "inquirer", "ethers", "web3", "openai", "langchain", "node-fetch", "form-data", "classnames", "styled-components",
  ]),
  [Ecosystem.PyPI]: new Set([
    "requests", "numpy", "pandas", "scipy", "matplotlib", "django", "flask", "fastapi", "pydantic", "sqlalchemy", "boto3", "botocore", "urllib3", "certifi",
    "setuptools", "wheel", "pytest", "black", "flake8", "mypy", "ruff", "cryptography", "pyyaml", "jinja2", "click", "rich", "httpx", "aiohttp", "beautifulsoup4",
    "lxml", "pillow", "tensorflow", "torch", "transformers", "scikit-learn", "openai", "anthropic", "langchain", "celery", "redis", "psycopg2", "pymongo",
    "selenium", "uvicorn", "gunicorn", "python-dotenv", "tqdm", "colorama", "paramiko", "pyjwt",
  ]),
  [Ecosystem.Crates]: new Set([
    "serde", "serde_json", "tokio", "clap", "anyhow", "thiserror", "reqwest", "rand", "regex", "chrono", "log", "tracing", "futures", "hyper", "axum", "actix-web",
    "sqlx", "diesel", "uuid", "itertools", "once_cell", "lazy_static", "bytes", "syn", "quote", "proc-macro2", "libc", "bitflags", "base64", "sha2", "rustls",
  ]),
  [Ecosystem.Go]: new Set([
    "github.com/gin-gonic/gin", "github.com/stretchr/testify", "github.com/spf13/cobra", "github.com/spf13/viper", "github.com/sirupsen/logrus", "go.uber.org/zap",
    "github.com/gorilla/mux", "github.com/gorilla/websocket", "google.golang.org/grpc", "google.golang.org/protobuf", "github.com/golang-jwt/jwt/v5",
    "gorm.io/gorm", "github.com/redis/go-redis/v9", "github.com/jackc/pgx/v5", "github.com/go-sql-driver/mysql", "github.com/lib/pq", "github.com/google/uuid",
    "github.com/labstack/echo/v4", "github.com/gofiber/fiber/v2", "github.com/go-chi/chi/v5", "github.com/prometheus/client_golang", "golang.org/x/crypto",
    "golang.org/x/net", "golang.org/x/sync", "gopkg.in/yaml.v3", "github.com/aws/aws-sdk-go-v2", "github.com/boltdb/bolt", "go.etcd.io/bbolt",
  ]),
  [Ecosystem.Maven]: new Set([
    "com.fasterxml.jackson.core:jackson-databind", "com.fasterxml.jackson.core:jackson-core", "org.springframework:spring-core", "org.springframework:spring-web",
    "org.springframework.boot:spring-boot-starter-web", "com.google.guava:guava", "org.apache.commons:commons-lang3", "commons-io:commons-io", "junit:junit",
    "org.junit.jupiter:junit-jupiter", "org.mockito:mockito-core", "org.slf4j:slf4j-api", "ch.qos.logback:logback-classic", "org.apache.logging.log4j:log4j-core",
    "com.google.code.gson:gson", "org.projectlombok:lombok", "org.apache.httpcomponents:httpclient", "com.squareup.okhttp3:okhttp", "org.postgresql:postgresql",
    "mysql:mysql-connector-java", "org.hibernate:hibernate-core", "io.netty:netty-all", "org.jetbrains.kotlin:kotlin-stdlib", "org.yaml:snakeyaml",
  ]),
}
