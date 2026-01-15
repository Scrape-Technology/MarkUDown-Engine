import logging
from typing import Dict, Any
from app.schemas.job import ScrapeOptions
# Importaremos as estratégias concretas aqui (criaremos no próximo passo)
from app.engine.strategies.standard import StandardStrategy
from app.engine.strategies.stealth import StealthStrategy
from app.engine.strategies.abrasio import AbrasioStrategy

logger = logging.getLogger(__name__)

class IntelligentOrchestrator:
    def __init__(self):
        # Inicializa as estratégias
        self.strategy_standard = StandardStrategy()
        self.strategy_stealth = StealthStrategy()
        self.strategy_abrasio = AbrasioStrategy()

    async def extract(self, url: str, options: ScrapeOptions) -> Dict[str, Any]:
        errors = []
        
        # CAMADA 1: Crawl4AI Standard (Rápido e Leve)
        # Pulamos se o usuário forçou o modo stealth
        if not options.force_stealth:
            try:
                logger.info(f"⚡ [1/3] Tentando Camada Standard: {url}")
                result = await self.strategy_standard.execute(url, options)
                if self._validate(result):
                    return self._package_response(result, "crawl4ai_standard")
            except Exception as e:
                logger.warning(f"⚠️ Camada Standard falhou: {str(e)}")
                errors.append(f"Standard: {str(e)}")

        # CAMADA 2: Crawl4AI Stealth (Modo Magic/Evasão)
        try:
            logger.info(f"🥷 [2/3] Tentando Camada Stealth: {url}")
            result = await self.strategy_stealth.execute(url, options)
            if self._validate(result):
                return self._package_response(result, "crawl4ai_stealth")
        except Exception as e:
            logger.warning(f"⚠️ Camada Stealth falhou: {str(e)}")
            errors.append(f"Stealth: {str(e)}")

        # CAMADA 3: Abrasio (Browser Real/Anti-Bot Pesado)
        try:
            logger.info(f"🛡️ [3/3] Tentando Camada Abrasio (Fallback Final): {url}")
            result = await self.strategy_abrasio.execute(url, options)
            if self._validate(result):
                return self._package_response(result, "abrasio_browser")
        except Exception as e:
            logger.error(f"❌ Camada Abrasio falhou: {str(e)}")
            errors.append(f"Abrasio: {str(e)}")

        # Se chegou aqui, nada funcionou
        raise Exception(f"Todas as tentativas de extração falharam. Log: {'; '.join(errors)}")

    def _validate(self, result: Dict) -> bool:
        """Verifica se o resultado é válido (não vazio, não captcha)"""
        if not result:
            return False
        content = result.get("markdown", "") or result.get("content", "")
        
        if len(content) < 50: # Conteúdo suspeitamente curto
            return False
        
        # Checagem básica de captcha no conteúdo
        block_terms = ["verify you are human", "enable javascript", "access denied"]
        if any(term in content.lower() for term in block_terms):
            return False
            
        return True

    def _package_response(self, raw_result: Dict, source: str) -> Dict:
        """Padroniza a saída final para o JSON"""
        return {
            "markdown": raw_result.get("markdown", ""),
            "metadata": raw_result.get("metadata", {}),
            "html": raw_result.get("html", ""), # Opcional
            "extraction_source": source,
            "success": True
        }