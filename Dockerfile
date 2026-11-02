FROM python:3.12.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN addgroup --system satgpt && adduser --system --ingroup satgpt satgpt

COPY agent/requirements.txt /app/agent/
RUN python -m pip install --upgrade pip \
    && python -m pip install "setuptools<81" \
    && python -m pip install -r /app/agent/requirements.txt \
    && python -m pip check

COPY --chown=satgpt:satgpt agent /app/agent
COPY --chown=satgpt:satgpt satgpt_config.py /app/satgpt_config.py
COPY --chown=satgpt:satgpt frontend/src/config/layerCatalog.json /app/frontend/src/config/layerCatalog.json

USER satgpt
WORKDIR /app/agent

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('AGENT_PORT','8000')+'/health', timeout=3)"

CMD ["python", "/app/satgpt_config.py", "basic"]
