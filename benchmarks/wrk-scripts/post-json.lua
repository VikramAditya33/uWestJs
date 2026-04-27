wrk.method = "POST"
wrk.path = "/api/data"
wrk.headers["Content-Type"] = "application/json"

local body = '{"name":"benchmark","value":12345,"active":true,"tags":["test","performance"]}'
wrk.body = body
