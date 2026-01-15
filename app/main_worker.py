import asyncio
import json
import logging
import os
import sys

# Adiciona o diretório atual ao path para resolver imports
sys.path.insert(0, os.getcwd())

import redis.asyncio as redis
from app.core.config import REDIS_URL
from app.schemas.job import JobPayload, JobStatus
from app.engine.orchestrator import IntelligentOrchestrator

# Configuração de Logs
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

async def process_job(payload: JobPayload, orchestrator: IntelligentOrchestrator):
    """
    Executa a extração e retorna o resultado.
    """
    logger.info(f"🕷️ Iniciando scrape para: {payload.url} | Modo Stealth: {payload.options.force_stealth}")
    
    # Chama o Orquestrador que gerencia os Fallbacks (1 -> 2 -> 3)
    result = await orchestrator.extract(payload.url, payload.options)
    
    return result

async def worker_loop():
    # Conexão com Redis
    r = redis.from_url(REDIS_URL, decode_responses=True)
    orchestrator = IntelligentOrchestrator()
    
    logger.info("🚀 MarkUDown Worker v2.0 Iniciado e aguardando tarefas...")
    
    while True:
        try:
            # 1. Aguarda tarefa na fila 'scrape_jobs_queue' (bloqueante)
            # Retorna tupla: (nome_da_fila, valor)
            _, message_json = await r.blpop("scrape_jobs_queue", timeout=0)
            
            if not message_json:
                continue

            # 2. Parse da mensagem
            try:
                payload = JobPayload.model_validate_json(message_json)
            except Exception as e:
                logger.error(f"❌ Erro ao decodificar JSON da fila: {e}")
                continue

            job_key = f"job_status:{payload.id}"
            
            # 3. Atualiza status para PROCESSING
            payload.status = JobStatus.PROCESSING
            payload.attempts_made += 1
            await r.set(job_key, payload.model_dump_json(), ex=86400)

            # 4. Executa o trabalho
            try:
                extraction_data = await process_job(payload, orchestrator)
                
                # Sucesso
                payload.status = JobStatus.COMPLETED
                payload.result = extraction_data
                logger.info(f"✅ Job {payload.id} concluído com sucesso!")

            except Exception as e:
                # Falha Fatal
                payload.status = JobStatus.FAILED
                payload.error = str(e)
                logger.error(f"💀 Falha fatal no Job {payload.id}: {e}")

            # 5. Salva estado final no Redis
            # (Calcula tempo de execução se quiser adicionar depois)
            await r.set(job_key, payload.model_dump_json(), ex=86400)

        except Exception as e:
            logger.error(f"⚠️ Erro no loop principal do worker: {e}")
            await asyncio.sleep(1) # Backoff para não floodar logs em caso de queda do Redis

if __name__ == "__main__":
    try:
        asyncio.run(worker_loop())
    except KeyboardInterrupt:
        logger.info("🛑 Worker encerrado manualmente.")