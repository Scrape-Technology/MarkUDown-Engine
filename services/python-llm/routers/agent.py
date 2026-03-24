"""
LLM-powered agent step decision-making.
Receives current page content, prompt, and history. Returns the next action for the agent.
"""

import json
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from google import genai
from pydantic import BaseModel
from dotenv import load_dotenv
load_dotenv()  # Load .env for GENAI_API_KEY
router = APIRouter()


class AgentStepHistory(BaseModel):
    step: int
    url: str
    action: str
    reasoning: str
    result: Optional[str] = None


class AgentStepRequest(BaseModel):
    prompt: str
    current_url: str
    page_content: str
    available_links: list[str] = []
    steps_so_far: list[AgentStepHistory] = []
    pages_visited: list[str] = []
    step_number: int = 1
    max_steps: int = 10
    allow_navigation: bool = True


class AgentStepResponse(BaseModel):
    action: str  # "answer", "navigate", "extract", "done"
    reasoning: str
    answer: Optional[str] = None
    target_url: Optional[str] = None
    extracted_data: Optional[str] = None


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


@router.post("/step/", response_model=AgentStepResponse)
async def agent_step(request: AgentStepRequest):
    api_key = os.getenv("GENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GENAI_API_KEY not configured")

    client = genai.Client(api_key=api_key)

    # Build history context
    history_text = ""
    if request.steps_so_far:
        history_text = "\n## Previous Steps:\n"
        for s in request.steps_so_far[-5:]:  # Last 5 steps for context window
            history_text += f"Step {s.step}: [{s.action}] {s.reasoning}"
            if s.result:
                history_text += f" → {s.result[:200]}"
            history_text += "\n"

    # Build available links context
    links_text = ""
    if request.available_links and request.allow_navigation:
        links_text = "\n## Available Links on Current Page:\n"
        for i, link in enumerate(request.available_links[:30]):
            links_text += f"{i+1}. {link}\n"

    nav_instruction = ""
    if request.allow_navigation:
        nav_instruction = """- "navigate": Go to a different URL to find more information. Set "target_url" to the URL. Only use links from the available list or construct URLs you're confident exist."""
    else:
        nav_instruction = '- Navigation is DISABLED. You cannot use "navigate". You must answer from the current page.'

    remaining = request.max_steps - request.step_number
    urgency = ""
    if remaining <= 2:
        urgency = "\n**IMPORTANT: You are running low on steps. Provide your best answer NOW using 'answer' action.**"

    prompt = f"""You are an intelligent web navigation agent. Your task is to answer the user's question by analyzing web pages.

## User's Question:
{request.prompt}

## Current URL: {request.current_url}
## Step {request.step_number} of {request.max_steps}
## Pages visited: {', '.join(request.pages_visited) or 'none yet'}
{urgency}
{history_text}
## Current Page Content:
{request.page_content[:25000]}
{links_text}
## Available Actions:
- "answer": You have enough information to answer the user's question. Set "answer" to your complete response.
{nav_instruction}
- "extract": Extract specific data from the current page. Set "extracted_data" to the extracted information.
- "done": Task is complete with all extracted data compiled.

## Instructions:
1. Analyze the current page content in relation to the user's question
2. Decide the best next action
3. Provide clear reasoning for your decision
4. Return ONLY a JSON object with this structure:
   {{"action": "answer|navigate|extract|done", "reasoning": "why this action", "answer": "if answering", "target_url": "if navigating", "extracted_data": "if extracting"}}

Output:"""

    try:
        response = client.models.generate_content(
            model="gemini-3-flash-preview",
            contents=prompt,
        )
        text = _clean_llm_json(response.text)
        data = json.loads(text)

        action = data.get("action", "answer")
        if action not in ("answer", "navigate", "extract", "done"):
            action = "answer"

        return AgentStepResponse(
            action=action,
            reasoning=data.get("reasoning", "No reasoning provided"),
            answer=data.get("answer"),
            target_url=data.get("target_url"),
            extracted_data=data.get("extracted_data"),
        )
    except json.JSONDecodeError:
        # LLM didn't return valid JSON — treat the raw text as an answer
        return AgentStepResponse(
            action="answer",
            reasoning="LLM returned non-JSON response, treating as direct answer",
            answer=response.text.strip() if response else "Failed to get response",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent step failed: {str(e)}")
