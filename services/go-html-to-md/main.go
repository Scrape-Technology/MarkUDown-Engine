package main

import (
	"net/http"
	"os"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	zerolog.TimeFieldFormat = time.RFC3339
	if os.Getenv("ENV") != "production" {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /convert", handleConvert)
	mux.HandleFunc("GET /health", handleHealth)

	log.Info().Str("port", port).Msg("Go HTML→Markdown service starting")
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal().Err(err).Msg("Server failed")
	}
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"healthy","service":"go-html-to-md"}`))
}
