"""
LLM-powered extraction planner.
Receives a system prompt + user message and returns the raw LLM text response.
Used by the smart-extract job to generate an action plan for a given site and goal.
"""

import os

from fastapi import APIRouter, HTTPException
from google import genai
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

router = APIRouter()


class PlanRequest(BaseModel):
    system: str
    message: str


class PlanResponse(BaseModel):
    text: str


@router.post("/", response_model=PlanResponse)
async def plan(request: PlanRequest):
    api_key = os.getenv("GENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GENAI_API_KEY not configured")

    client = genai.Client(api_key=api_key)

    prompt = f"{request.system}\n\n{request.message}"

    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash-preview-04-17",
            contents=prompt,
        )
        return PlanResponse(text=response.text or "")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Plan generation failed: {str(e)}")
