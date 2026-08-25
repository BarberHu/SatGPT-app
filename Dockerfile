FROM python:3.12.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN addgroup --system satgpt && adduser --system --ingroup satgpt satgpt

COPY agent/requirements.txt agent/requirements.lock.txt /app/agent/
RUN python -m pip install --upgrade pip \
    && python -m pip install "setuptools<81" \
    && python -m pip install -r /app/agent/requirements.lock.txt \
    && python -m pip check

COPY --chown=satgpt:satgpt agent /app/agent

USER satgpt
WORKDIR /app/agent

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"

CMD ["sh", "-c", "python -m uvicorn server:app --host ${AGENT_HOST} --port ${AGENT_PORT} --workers ${AGENT_WORKERS} --proxy-headers --forwarded-allow-ips '${FORWARDED_ALLOW_IPS}'"]
