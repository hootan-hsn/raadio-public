# Raadio controller: FastAPI + Telegram client + FFmpeg encoder

# ---- Build stage: compile wheels (TgCrypto needs a C compiler) ----
FROM python:3.12-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt /tmp/requirements.txt
RUN pip wheel --no-cache-dir --wheel-dir /wheels -r /tmp/requirements.txt

# ---- Runtime stage: Python + FFmpeg, no compiler ----
# tzdata: weekly studio shows follow the uploader's time zone (summer/winter time)
FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tzdata \
 && rm -rf /var/lib/apt/lists/*

# uid 1000 = the "ubuntu" user on the server, so files in ./data stay owned by you
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin app

COPY --from=build /wheels /wheels
RUN pip install --no-cache-dir --no-index /wheels/* && rm -rf /wheels

WORKDIR /app
COPY *.py /app/controller/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DATA_DIR=/data \
    API_HOST=0.0.0.0 \
    API_PORT=8080

USER app
EXPOSE 8080
CMD ["python", "-u", "/app/controller/radio_controller.py"]
