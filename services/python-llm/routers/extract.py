"""
LLM-based structured data extraction.
Receives scraped markdown/HTML from the TS worker, processes with Gemini,
and returns structured JSON according to the provided schema.
"""

import json
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from google import genai
from pydantic import BaseModel

router = APIRouter()


class ExtractRequest(BaseModel):
    url: Optional[str] = None
    markdown: str
    schema_fields: Optional[dict[str, str]] = None  # {"field_name": "type"} — optional for prompt-only mode
    extraction_scope: Optional[str] = None
    extraction_target: Optional[str] = None
    extract_query: Optional[str] = None
    prompt: Optional[str] = None  # Prompt-only mode: free-form extraction instruction


class ExtractResponse(BaseModel):
    success: bool
    data: list[dict]
    total: int


def _clean_llm_json(text: str) -> str:
    """Strip markdown code fences and leading 'json' label from LLM output."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()
    if text.startswith("json"):
        text = text[4:].strip()
    return text


def _build_schema_prompt(request: ExtractRequest) -> str:
    """Build a structured extraction prompt with schema fields."""
    schema_desc = json.dumps(request.schema_fields, indent=2)
    scope_info = ""
    if request.extraction_scope:
        scope_info += f"\nExtraction scope: {request.extraction_scope}"
    if request.extraction_target:
        scope_info += f"\nExtraction target: {request.extraction_target}"
    if request.extract_query:
        scope_info += f"\nUser query: {request.extract_query}"

    return f"""You are a structured data extraction engine. Extract data from the following web page content.

## Schema (extract these fields for each item found):
{schema_desc}

{scope_info}

## Source URL: {request.url or "unknown"}

## Content:
{request.markdown[:50000]}

## Instructions:
1. Extract ALL matching items from the content
2. Return a JSON array of objects, where each object has exactly the fields from the schema
3. If a field value is not found, set it to null
4. If the URL was provided in the schema, include the source URL of each item
5. Return ONLY the JSON array, no markdown, no explanation

Output:"""


def _build_prompt_only(request: ExtractRequest) -> str:
    """Build a prompt-only extraction prompt (no schema, free-form)."""
    user_prompt = request.prompt or request.extract_query or "Extract the most relevant structured data from this page."

    return f"""You are a data extraction engine. Extract structured data from the following web page content based on the user's instruction.

## User Instruction:
{user_prompt}

## Source URL: {request.url or "unknown"}

## Content:
{request.markdown[:50000]}

## Instructions:
1. Based on the user's instruction, identify and extract all relevant data
2. Determine the best fields/structure automatically
3. Return a JSON array of objects with meaningful field names
4. If only one item is relevant, still return it inside an array
5. Return ONLY the JSON array, no markdown, no explanation

Output:"""


@router.post("/", response_model=ExtractResponse)
async def extract_data(request: ExtractRequest):
    api_key = os.getenv("GENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GENAI_API_KEY not configured")

    if not request.schema_fields and not request.prompt and not request.extract_query:
        raise HTTPException(
            status_code=400,
            detail="Either 'schema_fields' or 'prompt' (or 'extract_query') must be provided",
        )

    client = genai.Client(api_key=api_key)

    # Choose prompt strategy: schema-based or prompt-only
    if request.schema_fields:
        llm_prompt = _build_schema_prompt(request)
    else:
        llm_prompt = _build_prompt_only(request)

    try:
        response = client.models.generate_content(
            model="gemini-3-flash-preview",
            contents=llm_prompt,
        )
        text = _clean_llm_json(response.text)

        data = json.loads(text)
        if not isinstance(data, list):
            data = [data]

        return ExtractResponse(success=True, data=data, total=len(data))
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="LLM returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Extraction failed: {str(e)}")
