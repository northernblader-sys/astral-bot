process.env.JWT_SECRET ??= '0123456789abcdef0123456789abcdef0123456789abcdef'
process.env.API_PORT = '45990'
process.env.ALLOWED_ORIGINS = 'http://localhost:4321,http://127.0.0.1:4321'
const { default: startApiServer } = await import('../lib/api-server.js')
const db = { data:{users:{},notifications:{},seasonRuntime:{activeSeasonId:'season_01',startedAt:Date.now(),endsAt:Date.now()+86400000}}, read:async()=>{}, write:async()=>{} }
startApiServer(db, [])
