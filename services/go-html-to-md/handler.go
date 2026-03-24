package main

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/rs/zerolog/log"
)

type ConvertRequest struct {
	HTML string `json:"html"`
}

type ConvertResponse struct {
	Markdown string `json:"markdown"`
	Success  bool   `json:"success"`
}

type ErrorResponse struct {
	Error   string `json:"error"`
	Success bool   `json:"success"`
}

func handleConvert(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	body, err := io.ReadAll(io.LimitReader(r.Body, 50*1024*1024)) // 50MB limit
	if err != nil {
		writeError(w, "Failed to read request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var req ConvertRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if req.HTML == "" {
		writeError(w, "HTML field is required", http.StatusBadRequest)
		return
	}

	markdown, err := convertHTMLToMarkdown(req.HTML)
	if err != nil {
		log.Error().Err(err).Msg("Conversion failed")
		writeError(w, "Conversion failed: "+err.Error(), http.StatusInternalServerError)
		return
	}

	resp := ConvertResponse{
		Markdown: markdown,
		Success:  true,
	}

	json.NewEncoder(w).Encode(resp)
}

func writeError(w http.ResponseWriter, msg string, status int) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(ErrorResponse{Error: msg, Success: false})
}
