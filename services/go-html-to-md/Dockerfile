FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /go-html-to-md .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates
COPY --from=builder /go-html-to-md /go-html-to-md

EXPOSE 3001
CMD ["/go-html-to-md"]
