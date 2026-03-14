import NodeCache from 'node-cache';
import path from 'path';
import zlib from 'zlib';

// Caches quentes que nao devem usar compressao (alto throughput, baixa latencia)
const HOT_CACHES = new Set(['msgRetry', 'messages', 'commands', 'indexGroupMeta']);

class OptimizedCacheManager {
    constructor() {
        this.caches = new Map();
        this.memoryThreshold = 0.85; // 85% da memória disponível
        this.cleanupInterval = 5 * 60 * 1000; // 5 minutos
        this.compressionEnabled = true;
        this.isOptimizing = false;
        this.lruOrder = new Map(); // For LRU eviction
        this.accessCounts = new Map(); // For dynamic TTL
        
        this.initializeCaches();
        this.startMemoryMonitoring();
    }

    /**
     * Inicializa os caches com configurações otimizadas
     */
    initializeCaches() {
        const cacheConfigs = [
            ['msgRetry', { stdTTL: 2 * 60, checkperiod: 30, maxKeys: 1000 }],
            ['groupMeta', { stdTTL: 10 * 60, checkperiod: 2 * 60, maxKeys: 500 }],
            ['indexGroupMeta', { stdTTL: 10, checkperiod: 30, maxKeys: 500 }],
            ['messages', { stdTTL: 60, checkperiod: 15, maxKeys: 2000 }],
            ['userData', { stdTTL: 30 * 60, checkperiod: 5 * 60, maxKeys: 2000 }],
            ['commands', { stdTTL: 5 * 60, checkperiod: 60, maxKeys: 5000 }],
            ['media', { stdTTL: 30, checkperiod: 10, maxKeys: 100 }],
        ];

        for (const [name, opts] of cacheConfigs) {
            const cache = new NodeCache({
                ...opts,
                useClones: false,
                deleteOnExpire: true,
                forceString: false
            });

            // Limpa lruOrder/accessCounts quando chaves expiram para evitar memory leak
            cache.on('expired', (key) => {
                this.lruOrder.delete(key);
                this.accessCounts.delete(key);
            });

            this.caches.set(name, cache);
        }
    }

    /**
     * Obtém cache específico
     */
    getCache(type) {
        return this.caches.get(type);
    }

    /**
     * Obtém valor do cache de metadados de grupos específico do index.js
     */
    async getIndexGroupMeta(groupId) {
        return await this.get('indexGroupMeta', groupId);
    }

    /**
     * Define valor no cache de metadados de grupos específico do index.js
     */
    async setIndexGroupMeta(groupId, value) {
        return await this.set('indexGroupMeta', groupId, value, 10); // 10 segundos TTL
    }

    /**
     * Define valor no cache com compressão opcional
     */
    async set(cacheType, key, value, ttl = null) {
        try {
            const cache = this.caches.get(cacheType);
            if (!cache) {
                return false;
            }

            let finalValue = value;

            // Comprime dados grandes se habilitado (apenas para caches frios)
            if (this.compressionEnabled && !HOT_CACHES.has(cacheType) && this.shouldCompress(value)) {
                finalValue = await this.compressData(value);
            }

            // Update access counts and LRU
            this.accessCounts.set(key, (this.accessCounts.get(key) || 0) + 1);
            this.lruOrder.set(key, Date.now());

            // Calculate dynamic TTL based on access frequency
            const accessCount = this.accessCounts.get(key);
            let dynamicTtl = ttl;
            if (!ttl && accessCount > 5) {
                dynamicTtl = Math.min(60 * 60, accessCount * 60); // Up to 1 hour for frequently accessed
            }

            if (dynamicTtl) {
                return cache.set(key, finalValue, dynamicTtl);
            } else {
                return cache.set(key, finalValue);
            }
        } catch (error) {
            console.error(`❌ Erro ao definir cache ${cacheType}:`, error.message);
            return false;
        }
    }

    /**
     * Obtém valor do cache com descompressão automática
     */
    async get(cacheType, key) {
        try {
            const cache = this.caches.get(cacheType);
            if (!cache) {
                return undefined;
            }

            let value = cache.get(key);
            
            if (value !== undefined) {
                // Update LRU and access counts
                this.lruOrder.set(key, Date.now());
                this.accessCounts.set(key, (this.accessCounts.get(key) || 0) + 1);

                if (this.compressionEnabled && this.isCompressed(value)) {
                    value = await this.decompressData(value);
                }
            }

            return value;
        } catch (error) {
            console.error(`❌ Erro ao obter cache ${cacheType}:`, error.message);
            return undefined;
        }
    }

    /**
     * Remove item do cache
     */
    del(cacheType, key) {
        try {
            const cache = this.caches.get(cacheType);
            if (cache) {
                const deleted = cache.del(key);
                if (deleted) {
                    this.lruOrder.delete(key);
                    this.accessCounts.delete(key);
                }
                return deleted;
            }
            return false;
        } catch (error) {
            console.error(`❌ Erro ao remover cache ${cacheType}:`, error.message);
            return false;
        }
    }

    /**
     * Limpa cache específico
     */
    clear(cacheType) {
        const cache = this.caches.get(cacheType);
        if (cache) {
            // Limpa entradas auxiliares de LRU/access para chaves deste cache
            for (const key of cache.keys()) {
                this.lruOrder.delete(key);
                this.accessCounts.delete(key);
            }
            cache.flushAll();
            return true;
        }
        return false;
    }

    /**
     * Verifica se dados devem ser comprimidos
     */
    shouldCompress(data) {
        try {
            const dataString = JSON.stringify(data);
            return dataString.length > 1024; // Comprime se > 1KB
        } catch {
            return false;
        }
    }

    /**
     * Comprime dados usando zlib
     */
    async compressData(data) {
        try {
            const dataString = JSON.stringify(data);
            const compressed = zlib.gzipSync(dataString);
            return {
                __compressed: true,
                data: compressed,
                originalSize: dataString.length,
                compressedSize: compressed.length,
                timestamp: Date.now()
            };
        } catch (error) {
            console.error('❌ Erro na compressão:', error.message);
            return data;
        }
    }

    /**
     * Verifica se dados estão comprimidos
     */
    isCompressed(data) {
        return data && typeof data === 'object' && data.__compressed === true;
    }

    /**
     * Descomprime dados usando zlib
     */
    async decompressData(compressedData) {
        try {
            if (!this.isCompressed(compressedData)) {
                return compressedData;
            }
            const decompressed = zlib.gunzipSync(compressedData.data);
            return JSON.parse(decompressed.toString());
        } catch (error) {
            console.error('❌ Erro na descompressão:', error.message);
            return compressedData;
        }
    }

    /**
     * Inicia monitoramento de memória
     */
    startMemoryMonitoring() {
        setInterval(async () => {
            await this.checkMemoryUsage();
        }, this.cleanupInterval);

        // Verifica imediatamente
        setTimeout(() => {
            this.checkMemoryUsage();
        }, 10000);
    }

    /**
     * Verifica uso de memória e otimiza se necessário
     */
    async checkMemoryUsage() {
        try {
            const memUsage = process.memoryUsage();
            const usedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
            const totalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
            const rssMB = Math.round(memUsage.rss / 1024 / 1024);
            
            const memoryPercentage = memUsage.heapUsed / memUsage.heapTotal;

            if (memoryPercentage > this.memoryThreshold) {
                await this.optimizeMemory('high_memory_usage');
            } else if (memoryPercentage > 0.7) {
                await this.optimizeMemory('moderate_memory_usage');
            }

            if (Date.now() % (30 * 60 * 1000) < this.cleanupInterval) {
                this.logCacheStatistics();
            }
        } catch (error) {
            console.error('❌ Erro ao verificar uso de memória:', error.message);
        }
    }

    /**
     * Otimiza uso de memória
     */
    async optimizeMemory(reason) {
        if (this.isOptimizing) return;
        this.isOptimizing = true;

        try {
            
            let freedMemory = 0;
            
            const cacheOrder = ['media', 'messages', 'commands', 'userData', 'indexGroupMeta', 'groupMeta', 'msgRetry'];
            
            for (const cacheType of cacheOrder) {
                const cache = this.caches.get(cacheType);
                if (cache) {
                    const beforeKeys = cache.keys().length;
                    
                    if (reason === 'high_memory_usage') {
                        if (['media', 'messages'].includes(cacheType)) {
                            cache.flushAll();
                        } else {
                            await this.removeOldCacheItems(cache, 0.5);
                        }
                    } else {
                        // Uso moderado: remove apenas 20% dos itens mais antigos
                        await this.removeOldCacheItems(cache, 0.2);
                    }
                }
                
                // Força garbage collection após cada cache
                if (global.gc) {
                    global.gc();
                }
            }

            // 2. Força garbage collection final
            if (global.gc) {
                global.gc();
            }

            // 3. Verifica resultado
            const newMemUsage = process.memoryUsage();
            const newUsedMB = Math.round(newMemUsage.heapUsed / 1024 / 1024);
            
        } catch (error) {
            console.error('❌ Erro durante otimização de memória:', error.message);
        } finally {
            this.isOptimizing = false;
        }
    }

    /**
     * Remove itens antigos do cache usando LRU
     */
    async removeOldCacheItems(cache, percentage) {
        try {
            const keys = cache.keys();
            const removeCount = Math.floor(keys.length * percentage);
            
            if (removeCount === 0) return;

            // Sort by LRU order (oldest first)
            const sortedKeys = keys.sort((a, b) => (this.lruOrder.get(a) || 0) - (this.lruOrder.get(b) || 0));
            const keysToRemove = sortedKeys.slice(0, removeCount);
            
            for (const key of keysToRemove) {
                cache.del(key);
                this.lruOrder.delete(key);
                this.accessCounts.delete(key);
            }
            
        } catch (error) {
            console.error('❌ Erro ao remover itens antigos do cache:', error.message);
        }
    }

    /**
     * Registra estatísticas dos caches
     */
    logCacheStatistics() {
        
        for (const [type, cache] of this.caches) {
            const keys = cache.keys();
            const stats = cache.getStats();
            
        }
    }

    /**
     * Obtém estatísticas completas
     */
    getStatistics() {
        const stats = {
            memory: process.memoryUsage(),
            caches: {},
            isOptimizing: this.isOptimizing,
            compressionEnabled: this.compressionEnabled
        };

        for (const [type, cache] of this.caches) {
            stats.caches[type] = {
                keys: cache.keys().length,
                stats: cache.getStats()
            };
        }

        return stats;
    }

    /**
     * Configura parâmetros de otimização
     */
    configure(options = {}) {
        if (options.memoryThreshold !== undefined) {
            this.memoryThreshold = Math.max(0.5, Math.min(0.95, options.memoryThreshold));
        }
        
        if (options.cleanupInterval !== undefined) {
            this.cleanupInterval = Math.max(60000, options.cleanupInterval); // Mínimo 1 minuto
        }
        
        if (options.compressionEnabled !== undefined) {
            this.compressionEnabled = options.compressionEnabled;
        }

    }

    /**
     * Força limpeza de todos os caches
     */
    forceCleanup() {
        for (const [type, cache] of this.caches) {
            cache.flushAll();
        }

        // Limpa Maps auxiliares por completo
        this.lruOrder.clear();
        this.accessCounts.clear();

        if (global.gc) {
            global.gc();
        }
    }

    /**
     * Para o monitoramento (para shutdown gracioso)
     */
    stopMonitoring() {
        this.isOptimizing = false;
    }
}

export default OptimizedCacheManager;
