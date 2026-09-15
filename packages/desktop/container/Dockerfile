FROM ubuntu:22.04@sha256:829f6df217bcbae2b371026e81711d1a787c61b2967ad09d015063663ebafbf7
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    libgtk-3-0 libnss3 libgbm1 libasound2 libxss1 libxtst6 libatspi2.0-0 \
    libdrm2 libxkbcommon0 libxrandr2 libxdamage1 libxcomposite1 libxfixes3 \
    libgl1-mesa-dri libgl1 xvfb xauth tini fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 neurodesk
COPY linux-unpacked/ /opt/neurodesk/
COPY entrypoint.sh /usr/local/bin/neurodesk-webapps
RUN chmod +x /usr/local/bin/neurodesk-webapps /opt/neurodesk/neurodesk-webapps
ENV ELECTRON_DISABLE_SANDBOX=1
USER neurodesk
WORKDIR /home/neurodesk
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/neurodesk-webapps"]
