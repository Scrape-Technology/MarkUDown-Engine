"""
LLM-based page summarization.
Receives scraped markdown from the TS worker, generates a concise summary via Gemini.
"""

import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from google import genai
from pydantic import BaseModel

router = APIRouter()


class SummarizeRequest(BaseModel):
    url: Optional[str] = None
    markdown: str
    max_length: Optional[int] = 500  # Target summary length in words
    language: Optional[str] = None  # Output language (None = same as source)


class SummarizeResponse(BaseModel):
    success: bool
    summary: str
    title: str
    key_points: list[str]


@router.post("/", response_model=SummarizeResponse)
async def summarize_page(request: SummarizeRequest):
    api_key = os.getenv("GENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GENAI_API_KEY not configured")

    client = genai.Client(api_key=api_key)

    lang_instruction = ""
    if request.language:
        lang_instruction = f"\nWrite the summary in {request.language}."

    prompt = f"""You are a content summarization engine. Summarize the following web page content.

## Source URL: {request.url or "unknown"}

## Content:
{request.markdown[:40000]}

## Instructions:
1. Write a concise summary of approximately {request.max_length} words
2. Extract a clear, descriptive title for the page
3. List 3-7 key points or takeaways as bullet points
4. Focus on the most important information{lang_instruction}
5. Return ONLY a JSON object with this structure:
   {{"title": "...", "summary": "...", "key_points": ["...", "..."]}}

Output:"""

    try:
        response = client.models.generate_content(
            model="gemini-3-flash-preview",
            contents=prompt,
        )
        text = response.text.strip()
        # Clean markdown code blocks
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
        if text.startswith("json"):
            text = text[4:].strip()

        import json
        data = json.loads(text)

        return SummarizeResponse(
            success=True,
            summary=data.get("summary", ""),
            title=data.get("title", ""),
            key_points=data.get("key_points", []),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Summarization failed: {str(e)}")
