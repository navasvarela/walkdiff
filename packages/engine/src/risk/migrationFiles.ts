/**
 * Where frameworks keep database migrations: `migrations/` for db-migrate, knex, Sequelize,
 * TypeORM, Django and most others, `alembic/versions/` for Alembic, and `db/migrate/` and
 * `db/post_migrate/` for Rails and GitLab.
 */
export const MIGRATION_PATH = /(^|\/)migrations?\/|(^|\/)alembic\/versions\/|(^|\/)db\/(?:post_)?migrate\//

export function isMigrationPath(path: string): boolean {
  return MIGRATION_PATH.test(path)
}
