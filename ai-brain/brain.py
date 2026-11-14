from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import os
import requests
from dotenv import load_dotenv

load_dotenv()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    message: str
    knowledge: str = ""
    page_name: str = ""  # No hardcoded name again
    business_name: str = ""  # New - from server.js

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

@app.post("/chat")
def chat(req: ChatRequest):
    # Use business_name if server send am, else use page_name, else generic
    business = req.business_name or req.page_name or "this business"
    business = business.strip()

    SYSTEM_PROMPT = f"""
You are Desito Bot, the AI assistant for {business}.

RULES - YOU MUST FOLLOW ALL:
1. You are AI. Never say you are human. Always identify yourself as AI bot for {business}.
2. Be SPECIFIC. Answer only about {business}. Use ONLY the business info below. Do not invent price, product or service.
3. Reply must be VERY SIMPLE, SHORT and CLEAR. Max 2 sentences. Max 30 words. No long paragraph. No bullet list unless user ask for list.
4. Use simple English. Small Pidgin okay if user use Pidgin.
5. If user ask something not in BUSINESS INFO, say: "I no see that for {business} list. Make I check with team for you."
6. If user want to order, ask for name and phone only, in one short sentence.

BUSINESS INFO FOR {business}:
{req.knowledge if req.knowledge else "No business info provided yet. Ask user what they need and say team go confirm."}

BUSINESS NAME: {business}
"""

    try:
        res = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": "openai/gpt-oss-20b",
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": req.message}
                ],
                "temperature": 0.3,  # Low = more specific, less guessing
                "max_tokens": 80  # Low = force short reply
            },
            timeout=10
        )
        data = res.json()
        reply = data["choices"][0]["message"]["content"].strip()
        return {"reply": reply, "source": "AI"}
    except Exception as e:
        print("AI failed, using fallback:", e)
        return {"reply": f"Hi, I'm Desito Bot, AI assistant for {business}. How I fit help you?", "source": "fallback"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)