"""
LLM-based CSS selector discovery for paginated list pages.
Receives raw HTML from page 1, returns stable CSS selectors for
item container, each requested field, and the next-page button.
"""

import json
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from google import genai
from pydantic import BaseModel
from bs4 import BeautifulSoup
router = APIRouter()


class DiscoverRequest(BaseModel):
    url: Optional[str] = None
    html: str
    extract_query: Optional[str] = None
    schema_fields: Optional[dict[str, str]] = None


class FieldSelector(BaseModel):
    selector: str
    attr: Optional[str] = None


class DiscoverResponse(BaseModel):
    success: bool
    item_container: str
    fields: dict[str, FieldSelector]
    pagination_next: Optional[str] = None


def _clean_llm_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()
    if text.startswith("json"):
        text = text[4:].strip()
    return text


def _build_discover_prompt(request: DiscoverRequest) -> str:
    fields_hint = ""
    if request.schema_fields:
        fields_hint = f"\n## Fields to extract (match these names exactly):\n{json.dumps(list(request.schema_fields.keys()), indent=2)}"
    elif request.extract_query:
        fields_hint = f"\n## What to extract:\n{request.extract_query}\n(Infer appropriate field names from the content.)"
    #soup = BeautifulSoup(request.html, "html.parser")
    #html = soup.find("body")
    return f"""You are a CSS selector discovery engine for web scraping.
Given the HTML of a paginated list page, identify stable CSS selectors that can extract the repeated data items.

{fields_hint}

## Source URL: {request.url or "unknown"}

## Page HTML (truncated to 80 000 chars):
{request.html}

## Task:
Analyse the HTML and return a JSON object with this EXACT structure:

{{
  "item_container": "<CSS selector matching each individual item — NOT the list wrapper>",
  "fields": {{
    "<field_name>": {{
      "selector": "<CSS selector relative to item_container>",
      "attr": "<attribute to read, e.g. 'href', 'src', or null to use text content>"
    }}
  }},
  "pagination_next": "<CSS selector for the next-page button/link, or null if not found>"
}}

## Rules:
1. item_container must match EACH item (e.g. "li.result" not "ul.results")
2. Prefer data-* attributes, IDs, semantic tags over generated/hashed class names (e.g. avoid .sc-abc123, .css-xyz456)
3. For links use attr "href"; for images use attr "src"; for text content use attr null
4. pagination_next must match the clickable element (a, button) — not a wrapper
5. Return ONLY the JSON object, no markdown fences, no explanation

Output:"""


@router.post("/", response_model=DiscoverResponse)
async def discover_selectors(request: DiscoverRequest):
    api_key = os.getenv("GENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GENAI_API_KEY not configured")

    if not request.html:
        raise HTTPException(status_code=400, detail="'html' field is required")

    client = genai.Client(api_key=api_key)
    llm_prompt = _build_discover_prompt(request)

    try:
        response = client.models.generate_content(
            model="gemini-3-flash-preview",
            contents=llm_prompt,
        )
        text = _clean_llm_json(response.text)
        data = json.loads(text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="LLM returned invalid JSON")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Selector discovery failed: {str(e)}")

    item_container = data.get("item_container", "")
    if not item_container:
        raise HTTPException(status_code=422, detail="LLM did not return item_container")

    raw_fields = data.get("fields", {})
    fields: dict[str, FieldSelector] = {}
    for name, spec in raw_fields.items():
        if isinstance(spec, dict) and "selector" in spec:
            fields[name] = FieldSelector(
                selector=spec["selector"],
                attr=spec.get("attr") or None,
            )

    return DiscoverResponse(
        success=True,
        item_container=item_container,
        fields=fields,
        pagination_next=data.get("pagination_next") or None,
    )
