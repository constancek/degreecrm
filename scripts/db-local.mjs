// Runs a local Postgres for dev and e2e tests (no Docker needed).
// Data lives in .pgdata/ (gitignored). Ctrl+C to stop.
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";

const port = Number(process.env.LOCAL_PG_PORT ?? 54329);
const pg = new EmbeddedPostgres({
  databaseDir: ".pgdata",
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
  onLog: () => {},
});

const fresh = !existsSync(".pgdata/PG_VERSION");
if (fresh) await pg.initialise();
await pg.start();
for (const name of ["degreecrm", "degreecrm_test"]) {
  try {
    await pg.createDatabase(name);
  } catch {
    // already exists
  }
}
console.log(`Postgres ready on postgresql://postgres:postgres@localhost:${port}/degreecrm`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
