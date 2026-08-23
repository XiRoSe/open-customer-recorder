# cluster-service

Standalone worker that runs the multi-dimensional clustering cycle
(embeddings → bisecting k-means → PCA → LLM segment naming) off the
`clustering` BullMQ queue, against the shared Postgres. It schedules its
own repeatable job every 10 minutes.

Required env: `DATABASE_URL`, `REDIS_URL`, `LLM_SERVICE_URL`.

Deploy (Railway): the build context must contain this directory's files
plus the repo's `lib/` — assemble a staging dir and `railway up` from it:

```sh
STAGE=$(mktemp -d)
cp cluster-service/* "$STAGE"/
cp -r lib "$STAGE"/lib
cd "$STAGE" && railway link -p <project-id> -s cluster-service -e production && railway up --detach
```
