FROM node:22-alpine AS build

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client ./

ARG VITE_WEBTRANSPORT_URL=https://wt.yourdomain.com/webtransport
ARG VITE_CERTIFICATE_HASH=
ENV VITE_WEBTRANSPORT_URL=$VITE_WEBTRANSPORT_URL
ENV VITE_CERTIFICATE_HASH=$VITE_CERTIFICATE_HASH

RUN npm run build

FROM nginx:1.27-alpine

RUN mkdir -p /etc/letsencrypt/live/nilo.luchang.xyz

COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80
