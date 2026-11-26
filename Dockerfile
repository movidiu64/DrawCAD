# LibreDWG's dwg2dxf (GPL-3.0-or-later) for opening DWG drawings, built from the release tarball;
# only the static binary goes into the image
FROM python:3.13-slim AS libredwg
ARG LIBREDWG_VERSION=0.14
ARG LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl pkgconf xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# one step each, so a failure says where; configure and make show their own error lines (the same base
# as the image below: dwg2dxf needs only its C library)
RUN curl -fsSL --retry 3 -o libredwg.tar.xz \
      "https://github.com/LibreDWG/libredwg/releases/download/${LIBREDWG_VERSION}/libredwg-${LIBREDWG_VERSION}.tar.xz" \
 && ls -l libredwg.tar.xz \
 && echo "${LIBREDWG_SHA256}  libredwg.tar.xz" | sha256sum -c - \
 && tar xf libredwg.tar.xz
WORKDIR /build/libredwg-${LIBREDWG_VERSION}
RUN ./configure --disable-bindings --disable-python --disable-docs --disable-werror \
      --disable-shared --enable-static --enable-release > configure.out 2>&1 \
 || { tail -n 40 configure.out; echo "--- config.log"; tail -n 60 config.log; exit 1; }
RUN make -j"$(nproc)" -C src > make.out 2>&1 \
 || { grep -n -m 20 -E "error|Error" make.out; tail -n 30 make.out; exit 1; }
RUN make -C programs dwg2dxf \
 && strip programs/dwg2dxf \
 && install -m 0755 programs/dwg2dxf /usr/local/bin/dwg2dxf \
 && install -m 0644 COPYING /usr/local/share/libredwg-COPYING \
 && /usr/local/bin/dwg2dxf --version

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DRAWCAD_DATA=/data \
    DRAWCAD_FRONTEND=/app/frontend \
    DRAWCAD_FONT=/app/frontend/fonts/osifont.ttf \
    PUID=99 \
    OMP_THREAD_LIMIT=1 \
    MALLOC_ARENA_MAX=2 \
    PGID=100

# Tesseract for text recognition (OCR) on scanned drawings: Romanian + English
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-ron tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

COPY --from=libredwg /usr/local/bin/dwg2dxf /usr/local/bin/dwg2dxf
COPY --from=libredwg /usr/local/share/libredwg-COPYING /usr/share/doc/libredwg/COPYING

WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
COPY frontend /app/frontend
COPY docker/entrypoint.sh /entrypoint.sh
COPY LICENSE /app/LICENSE
COPY VERSION /app/VERSION

# the version shown in Settings: the release given by CI, or VERSION + the build time for an image
# built from source (a git stack), so every build can be told apart
ARG DRAWCAD_VERSION=""
RUN if [ -n "$DRAWCAD_VERSION" ]; then v="$DRAWCAD_VERSION"; else v="$(cat /app/VERSION) · $(date -u '+%Y-%m-%d %H:%M') UTC"; fi \
 && printf '%s' "$v" > /app/frontend/version.txt

LABEL org.opencontainers.image.title="DrawCAD" \
      org.opencontainers.image.description="Self-hosted PDF editor for technical drawings: dimensions, tolerances, GD&T, revisions, OCR, opens DXF / DWG, DXF export" \
      org.opencontainers.image.source="https://github.com/movidiu64/DrawCAD" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
RUN chmod 0755 /entrypoint.sh && mkdir -p /data

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4)"

# the entrypoint prepares /data as root, then runs the app as PUID:PGID
ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
