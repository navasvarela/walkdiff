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
}
