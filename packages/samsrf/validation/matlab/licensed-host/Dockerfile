# MATLAB R2023b's own system dependencies (Ubuntu 22.04), plus the Docker CLI that
# MATLAB Compiler's Runtime image builder and compiler.package.docker call. MATLAB
# itself is installed by mpm on the host and mounted read-only; no license is in
# the image.
FROM mathworks/matlab-deps@sha256:655831572838baab3da6bb9efb9818a4514bd41c46e0ec2898ee9fdb930371cb
RUN apt-get update \
    && apt-get install --no-install-recommends -y docker.io git python3 python3-venv util-linux \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
