/**
 * CSP-safe Ajv shim for Chrome extensions
 * 
 * Ajv uses new Function() for performance, which violates Chrome extension CSP.
 * This shim provides a minimal implementation that validates without eval.
 * 
 * Trade-off: Less thorough validation, but works in extension context.
 */

class AjvCSPSafe {
  constructor(options = {}) {
    this.schemas = new Map();
    this.options = options;
  }

  compile(schema) {
    // Return a validator function that does basic type checking
    // without using eval/Function
    return (data) => {
      const errors = [];
      
      if (!this._validate(schema, data, '', errors)) {
        const validator = () => false;
        validator.errors = errors;
        return false;
      }
      
      return true;
    };
  }

  _validate(schema, data, path, errors) {
    if (!schema || typeof schema !== 'object') {
      return true; // No schema = valid
    }

    // Handle type checking
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actualType = this._getType(data);
      
      if (!types.includes(actualType) && !(actualType === 'integer' && types.includes('number'))) {
        errors.push({
          instancePath: path,
          schemaPath: `${path}/type`,
          keyword: 'type',
          params: { type: schema.type },
          message: `must be ${schema.type}`
        });
        return false;
      }
    }

    // Handle required properties
    if (schema.required && Array.isArray(schema.required) && typeof data === 'object' && data !== null) {
      for (const prop of schema.required) {
        if (!(prop in data)) {
          errors.push({
            instancePath: path,
            schemaPath: `${path}/required`,
            keyword: 'required',
            params: { missingProperty: prop },
            message: `must have required property '${prop}'`
          });
          return false;
        }
      }
    }

    // Handle properties (recursive)
    if (schema.properties && typeof data === 'object' && data !== null) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          if (!this._validate(propSchema, data[key], `${path}/${key}`, errors)) {
            return false;
          }
        }
      }
    }

    // Handle items (arrays)
    if (schema.items && Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        if (!this._validate(schema.items, data[i], `${path}/${i}`, errors)) {
          return false;
        }
      }
    }

    // Handle enum
    if (schema.enum && !schema.enum.includes(data)) {
      errors.push({
        instancePath: path,
        schemaPath: `${path}/enum`,
        keyword: 'enum',
        params: { allowedValues: schema.enum },
        message: `must be one of: ${schema.enum.join(', ')}`
      });
      return false;
    }

    return true;
  }

  _getType(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'integer' : 'number';
    }
    return typeof value;
  }

  addSchema(schema, key) {
    this.schemas.set(key || schema.$id, schema);
    return this;
  }

  getSchema(key) {
    const schema = this.schemas.get(key);
    return schema ? this.compile(schema) : undefined;
  }

  validate(schemaOrRef, data) {
    const schema = typeof schemaOrRef === 'string' 
      ? this.schemas.get(schemaOrRef) 
      : schemaOrRef;
    
    if (!schema) return true;
    
    const validator = this.compile(schema);
    return validator(data);
  }
}

// Export as default (matching Ajv's export)
export default AjvCSPSafe;

