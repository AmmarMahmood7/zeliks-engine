FROM node:22-alpine
# python3 is for the pack prompt builder (prompts/build_prompt.py), which
# the loader calls so the compiled prompt has exactly one source of truth.
RUN apk add --no-cache python3
WORKDIR /app
COPY website-agent/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY website-agent/ ./
COPY engine/packs/ ./engine/packs/
COPY engine/prompts/ ./engine/prompts/
EXPOSE 8080
CMD ["node", "server.js"]
