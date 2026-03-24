"""
Schema generation from natural language queries using Gemini.
Reused from the existing API create-schema logic.
"""

import json
import os

from fastapi import APIRouter, HTTPException
from google import genai
from pydantic import BaseModel

router = APIRouter()


class SchemaRequest(BaseModel):
    query: str


@router.post("/create")
async def create_schema(request: SchemaRequest):
    api_key = os.getenv("GENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GENAI_API_KEY not configured")

    client = genai.Client(api_key=api_key)

    try:
      response = client.models.generate_content(
        model="gemini-3-flash-preview",
        contents=f"""You are a smart JSON schema generator for a web scraper. Input: {request.query}
        Your job is to produce a single, valid JSON object containing the schema based on the input query. Produce *only* the JSON object, with no additional text, comments, or explanations before or after it.

        The JSON object must have exactly these fields:
        - **url**: The target page or site root URL to crawl (ensure it starts with http:// or https://). Omit or set to `null` if not present in the query.
        - **extraction_scope**: Choose ONE from: "whole_site", "category", "single_page", "search_query", "list_page", "unknown".
        - **extraction_target**: The specific target (category name, search term), or `null` for whole_site/single_page/list_page/unknown.
        - **<field>**: For each data parameter in the query, a key with its name and a string value for its type (e.g., "string", "float", "integer", "date", "url").
        - **allowed_words**: 5-10 keywords likely in relevant URLs/page elements.
        - **blocked_words**: 5-10 keywords likely in irrelevant URLs/pages.
        - **allowed_patterns**: Up to 5 path fragments indicating relevant URLs. Return `[]` if unsure.
        - **blocked_patterns**: Up to 5 path fragments for irrelevant URLs. Return `[]` if unsure.

        Rules:
        1. Infer extraction_scope and extraction_target from the query's semantic meaning.
        2. Infer parameter names and types from the input query text.
        3. Do not include the site's domain name in allowed/blocked words or patterns.
        4. Output *only* the raw JSON object. No markdown, no explanations.
        5. Do not include ; in JSON.
        """,
      )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Schema generation failed: {str(e)}")

    text = response.text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()
    if text.startswith("json"):
        text = text[4:].strip()

    try:
        parsed = json.loads(text)
        return {"success": True, "schema": parsed}
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="LLM returned invalid JSON for schema generation")
