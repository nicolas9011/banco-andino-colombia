// Debe ejecutarse antes de importar config: rondas bcrypt bajas y sin limite de login en pruebas.
process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4';
process.env.LOGIN_RATE_MAX = '100000';
process.env.LOGIN_MAX_FAILS = '5';
