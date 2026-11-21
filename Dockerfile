FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
# Runs as root on purpose: a freshly mounted volume is owned by root and the
# container only runs this one single-user app inside its own VM/sandbox.
EXPOSE 8080
CMD ["node", "server.js"]
