FROM python:3.12.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN addgroup --system satgpt && adduser --system --ingroup satgpt satgpt
COPY requirements.txt /app/
RUN python -m pip install --upgrade pip \
    && python -m pip install -r /app/requirements.txt \
    && python -m pip check
COPY --chown=satgpt:satgpt basic /app/basic
COPY --chown=satgpt:satgpt harness/__init__.py /app/harness/__init__.py
COPY --chown=satgpt:satgpt harness/app /app/harness/app
COPY --chown=satgpt:satgpt harness/integrations /app/harness/integrations
COPY --chown=satgpt:satgpt satgpt_config.py satgpt_backend.py /app/
COPY --chown=satgpt:satgpt frontend/src/config/layerCatalog.json /app/frontend/src/config/layerCatalog.json
RUN mkdir -p /app/harness/state && chown -R satgpt:satgpt /app/harness
USER satgpt
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('AGENT_PORT','8000')+'/readyz', timeout=3)"
CMD ["python", "/app/satgpt_config.py", "backend"]
