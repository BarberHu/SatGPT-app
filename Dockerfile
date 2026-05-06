FROM python:3.12-slim

WORKDIR /app

RUN pip install --upgrade pip

COPY agent/requirements.txt /app/agent/requirements.txt
RUN pip install --no-cache-dir -r /app/agent/requirements.txt

COPY . /app

EXPOSE 8000

CMD ["python", "agent/server.py"]
