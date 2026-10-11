const {createSentinel}=require('/app/node_modules/redis')
const {redisConnection}=require('/app/server/redis-connection.cjs')
;(async()=>{
 const client=createSentinel(redisConnection(process.env).options);client.on('error',()=>{});await client.connect()
 const master=client.getMasterNode();await client.destroy()
 const e=process.env
 Object.assign(e,{S2T_TEST_POSTGRES_HOST:e.S2T_POSTGRES_HOST,S2T_TEST_POSTGRES_PORT:e.S2T_POSTGRES_PORT||'5432',S2T_TEST_POSTGRES_DB:e.S2T_POSTGRES_DB_NAME,S2T_TEST_POSTGRES_USER:e.S2T_POSTGRES_USER,S2T_TEST_POSTGRES_PASSWORD:e.S2T_POSTGRES_PASSWORD,S2T_TEST_MINIO_ENDPOINT:e.S2T_MINIO_ENDPOINT,S2T_TEST_MINIO_ACCESS_KEY:e.S2T_MINIO_ACCESS_KEY,S2T_TEST_MINIO_SECRET_KEY:e.S2T_MINIO_SECRET_KEY,S2T_TEST_REDIS_URL:'redis://'+(e.S2T_REDIS_USERNAME?encodeURIComponent(e.S2T_REDIS_USERNAME):'')+':'+encodeURIComponent(e.S2T_REDIS_PASSWORD)+'@'+master.host+':'+master.port})
 require('/app/tests/integration/scale-safety-integration.cjs')
})().catch(e=>{console.error(e.message);process.exitCode=1})
