# Recap Studio — Docker image for Render
FROM node:20-slim

# ffmpeg (with libass for subtitle burn-in), fontconfig (so libass can find
# the Myanmar font), curl (to download the font), ca-certificates (HTTPS).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg fontconfig curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Noto Sans Myanmar — needed to render Burmese subtitles. Fetched at build
# time so the repo stays small (no large font binaries committed).
RUN mkdir -p /usr/share/fonts/truetype/noto \
    && curl -sL -o /usr/share/fonts/truetype/noto/NotoSansMyanmar-Regular.ttf \
         "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansMyanmar/NotoSansMyanmar-Regular.ttf" \
    && curl -sL -o /usr/share/fonts/truetype/noto/NotoSansMyanmar-Bold.ttf \
         "https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSansMyanmar/NotoSansMyanmar-Bold.ttf" \
    && fc-cache -f

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production
ENV WORK_DIR=/data/jobs
ENV FONT_DIR=/usr/share/fonts/truetype/noto
ENV RECAP_MOCK=0

EXPOSE 3000
CMD ["node", "server.js"]
