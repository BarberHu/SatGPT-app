# Docker Production Deployment

This directory is the formal server deployment entry point. Run all commands
from the repository root so Compose can read the root `.env` file explicitly.

Build and start:

```bash
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.yml up -d --build
```

Inspect status and logs:

```bash
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.yml ps
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.yml logs --tail 100 -f
```

Stop the deployment:

```bash
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.yml down
```

These commands work with Docker Compose on a Linux server and with Docker
Desktop for local container verification. Agent port 8000 and Runtime port 5000
are exposed only to the Compose network; the configured frontend port is the
only host-published application port.
