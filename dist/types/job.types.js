"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResponseType = exports.JobStatus = void 0;
var JobStatus;
(function (JobStatus) {
    JobStatus["PENDING"] = "PENDING";
    JobStatus["PROCESSING"] = "PROCESSING";
    JobStatus["COMPLETED"] = "COMPLETED";
    JobStatus["FAILED"] = "FAILED";
})(JobStatus || (exports.JobStatus = JobStatus = {}));
var ResponseType;
(function (ResponseType) {
    ResponseType["SIMULATION"] = "simulation";
    ResponseType["SUBMISSION"] = "submission";
    ResponseType["RECEIPT"] = "receipt";
    ResponseType["ERROR"] = "error";
})(ResponseType || (exports.ResponseType = ResponseType = {}));
