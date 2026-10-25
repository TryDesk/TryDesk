FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY signaling-server.js ./
ENV PORT=9100
EXPOSE 9100
CMD ["node", "signaling-server.js"]
