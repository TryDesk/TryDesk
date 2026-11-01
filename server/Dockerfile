FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY signaling-server.js ./
ENV PORT=9100
EXPOSE 9100
CMD ["node", "signaling-server.js"]
