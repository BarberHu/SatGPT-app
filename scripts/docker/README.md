# Docker Deployment

Run from the repository root:

```bash
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml up -d --build
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml ps
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml logs --tail 100 -f
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml down
```

The frontend binds to host loopback. Basic port 8000 and Harness port 8001 stay
inside the Compose network.
