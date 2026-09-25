FROM python:3.12-slim-bookworm
WORKDIR /app
COPY requirements.txt ./
# Binary pillow-heif wheel supplies its own libheif and HEVC decoder.
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY preview.py runtime_config.py main.py ./
RUN useradd --uid 10001 --create-home worker
USER worker
ENV PYTHONUNBUFFERED=1
CMD ["python", "main.py"]
