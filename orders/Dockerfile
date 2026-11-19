# One image for the orders service, the local consumer, the Nimbus agent and the provisioning step.
# Build context: this folder, plus the Flagship repo as the named context "flagship" (for the SDK).
FROM node:24-alpine AS sdk
WORKDIR /flagship
COPY --from=flagship tsconfig.base.json ./
COPY --from=flagship packages/core ./packages/core
COPY --from=flagship packages/sdk ./packages/sdk
RUN npm i -g typescript@5.9.3 --silent \
 && cd packages/core && rm -rf node_modules && tsc -p tsconfig.json \
 && cd ../sdk && rm -rf node_modules && mkdir -p node_modules/@flagship && cp -r ../core node_modules/@flagship/core && tsc -p tsconfig.json

FROM node:24-alpine
WORKDIR /app/orders
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=sdk /flagship/packages/core/package.json /app/orders/node_modules/@flagship/core/package.json
COPY --from=sdk /flagship/packages/core/dist /app/orders/node_modules/@flagship/core/dist
COPY --from=sdk /flagship/packages/sdk/package.json /app/orders/node_modules/@flagship/sdk/package.json
COPY --from=sdk /flagship/packages/sdk/dist /app/orders/node_modules/@flagship/sdk/dist
COPY src ./src
COPY provision.mjs ./
USER node
CMD ["node", "src/service.ts"]
