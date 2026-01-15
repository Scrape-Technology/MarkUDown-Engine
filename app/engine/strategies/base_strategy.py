from abc import ABC, abstractmethod
from typing import Dict, Any
from app.schemas.job import ScrapeOptions

class BaseScraperStrategy(ABC):
    @abstractmethod
    async def execute(self, url: str, options: ScrapeOptions) -> Dict[str, Any]:
        """
        Executa o scraping e retorna um dicionário com:
        {
            'markdown': str,
            'html': str,
            'metadata': dict
        }
        """
        pass