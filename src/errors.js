export class ServiceError extends Error {
    constructor(code, message, statusCode = 422) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
    }
}
