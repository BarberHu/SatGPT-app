FROM python:3.12.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app/harness

COPY harness/requirements.txt /app/harness/requirements.txt
RUN python -m pip install --upgrade pip \
    && python -m pip install -r /app/harness/requirements.txt

COPY harness/app /app/harness/app
COPY harness/integrations /app/harness/integrations
RUN useradd --system --create-home satgpt \
    && mkdir -p /app/harness/state \
    && chown -R satgpt:satgpt /app/harness
USER satgpt

EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=3)"
CMD ["python", "-m", "app"]
