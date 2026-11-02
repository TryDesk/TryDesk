FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY signaling-server.js ./
ENV PORT=9100
EXPOSE 9100
# Not root: a hole in the server must not hand over the container. /data (owners file) must be writable by uid 1000:
# a new named volume copies this folder's owner; an existing one needs `chown -R 1000:1000` once (deploy of 3 Nov 2026).
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "signaling-server.js"]
