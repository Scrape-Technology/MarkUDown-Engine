"""
Deep research endpoint.
Takes a research query and multiple scraped pages, synthesizes a comprehensive answer using LLM.
"""

import json
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from google import genai
from pydantic import BaseModel

router = APIRouter()


class ResearchPage(BaseModel):
    url: str
    markdown: str
    title: Optional[str] = None


class DeepResearchRequest(BaseModel):
    query: str
    pages: list[ResearchPage]
    max_tokens: Optional[int] = 4096


class DeepResearchResponse(BaseModel):
    success: bool
    research: str
    sources: list[str]
    pages_analyzed: int


@router.post("/", response_model=DeepResearchResponse)
async def deep_research(request: DeepResearchRequest):
    api_key = os.getenv("GENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GENAI_API_KEY not configured")

    client = genai.Client(api_key=api_key)

    # Build context from all pages
    context_parts = []
    sources = []
    for i, page in enumerate(request.pages):
        title = page.title or page.url
        # Truncate each page to avoid exceeding context limits
        content = page.markdown[:15000]
        context_parts.append(f"### Source {i + 1}: {title}\nURL: {page.url}\n\n{content}")
        sources.append(page.url)

    context = "\n\n---\n\n".join(context_parts)

    prompt = f"""You are a research analyst. Based on the following web sources, provide a comprehensive, well-structured answer to the research query.

## Research Query:
{request.query}

## Sources:
{context}

## Instructions:
1. Synthesize information from ALL provided sources
2. Structure your response with clear headings and sections
3. Cite sources using [Source N] notation where N is the source number
4. Highlight key findings, trends, and insights
5. If sources contain conflicting information, note the discrepancies
6. Provide a conclusion/summary at the end
7. Write in a professional, analytical tone
8. Use markdown formatting for readability

Research Report:"""

    try:
        response = client.models.generate_content(
            model="gemini-3-flash-preview",
            contents=prompt,
        )

        return DeepResearchResponse(
            success=True,
            research=response.text,
            sources=sources,
            pages_analyzed=len(request.pages),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Deep research failed: {str(e)}")
