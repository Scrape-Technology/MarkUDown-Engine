package main

import (
	"strings"

	htmltomarkdown "github.com/JohannesKaufmann/html-to-markdown/v2"
)

func convertHTMLToMarkdown(html string) (string, error) {
	markdown, err := htmltomarkdown.ConvertString(html)
	if err != nil {
		return "", err
	}

	// Post-processing: clean up excessive blank lines
	lines := strings.Split(markdown, "\n")
	var cleaned []string
	blankCount := 0
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			blankCount++
			if blankCount <= 2 {
				cleaned = append(cleaned, "")
			}
		} else {
			blankCount = 0
			cleaned = append(cleaned, line)
		}
	}

	result := strings.TrimSpace(strings.Join(cleaned, "\n"))
	return result, nil
}
