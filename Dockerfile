FROM node:24-alpine AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend ./frontend
RUN npm run build

FROM golang:1.26.1-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY backend ./backend
COPY --from=frontend /src/backend/react-web/dist ./backend/react-web/dist
ARG APP_VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.buildVersion=${APP_VERSION}" -o /finance ./backend

FROM scratch
ARG APP_VERSION=dev
LABEL org.opencontainers.image.revision=$APP_VERSION
LABEL io.financeapp.component=api
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /finance /finance
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/finance"]
