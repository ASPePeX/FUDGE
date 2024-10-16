namespace FudgeCore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type General = any;

  /**
   * Holds information needed to recreate an object identical to the one it originated from. 
   * A serialization is used to create copies of existing objects at runtime or to store objects as strings or recreate them.
   */
  export interface Serialization {
    [type: string]: General;
  }

  export interface Serializable {
    /**
     * Returns a {@link Serialization} of this object.
     */
    serialize(): Serialization;
    /**
     * Recreates this instance of {@link Serializable} with the information from the given {@link Serialization}.
     */
    deserialize(_serialization: Serialization): Promise<Serializable>;
  }

  interface NamespaceRegister {
    [name: string]: Object;
  }

  /**
   * Decorator to mark properties of a {@link Component} for automatic serialization and editor configuration.
   * 
   * **Editor Configuration**:
   * Specify a type (constructor) for an attribute within a class's {@link Metadata | metadata}.
   * This allows the intended type of an attribute to be known by the editor (at runtime), making it:
   * - A valid drop target (e.g., for objects like {@link Node}, {@link Texture}, {@link Mesh}).
   * - Display the appropriate input element, even if the attribute has not been set (`undefined`).
   * 
   * **Serialization**:
   * The automatic serialization occurs after an instance's {@link Serializable.serialize} / {@link Serializable.deserialize} method was called.
   * - Primitives will be serialized as is.
   * - {@link Serializable}s will be serialized nested. Pass `true` as second argument to serailize {@link SerializableResource}s as project resources. Project resources are serialized via their resource id and fetched with it from the project when deserialized.
   * - {@link Node}s will be serialized as a path connecting them through the hierarchy, if found. During deserialization, the path will be unwound to find the instance in the current hierarchy. They will be available ***after*** {@link EVENT.GRAPH_DESERIALIZED}/{@link EVENT.GRAPH_INSTANTIATED} was broadcast through the hierarchy.
   * 
   * **Note:** Attributes with a specified type will always be included in the {@link Mutator base-mutator} 
   * (via {@link Mutable.getMutator}), regardless of their own type. Non-{@link Mutable mutable} objects 
   * will be displayed via their {@link toString} method in the editor.
   */
  export function serialize(_constructor: abstract new (...args: General[]) => General, _asResource: boolean = false): (_value: unknown, _context: ClassFieldDecoratorContext | ClassGetterDecoratorContext | ClassAccessorDecoratorContext) => void {
    return (_value: unknown, _context: ClassMemberDecoratorContext) => { // could cache the decorator function for each class
      if (typeof _context.name != "string")
        return;

      let meta: Metadata = _context.metadata;

      meta.attributeTypes ??= {};
      meta.attributeTypes[_context.name] = _constructor;

      let type: "primitve" | "nested"|  "resource" | "node";
      if (_constructor == String || _constructor == Number || _constructor == Boolean)
        type = "primitve";
      else if (_constructor == Node)
        type = "node";
      else if (_constructor.prototype.serialize && _asResource)
        type = "resource";
      else if (_constructor.prototype.serialize)
        type = "nested";

      if (type)
        (meta.serializables ??= {})[_context.name] = type;
    };
  }

  /**
   * Handles the external serialization and deserialization of {@link Serializable} objects. The internal process is handled by the objects themselves.  
   * A {@link Serialization} object can be created from a {@link Serializable} object and a JSON-String may be created from that.  
   * Vice versa, a JSON-String can be parsed to a {@link Serialization} which can be deserialized to a {@link Serializable} object.
   * ```text
   *  [Serializable] → (serialize) → [Serialization] → (stringify) → [String] → (save or send)
   *                                        ↓                            ↓                  ↓         
   *                [Serializable] ← (deserialize) ← [Serialization] ← (parse) ← (load) ← [Medium]
   * ```      
   * While the internal serialize/deserialize method1s of the objects care of the selection of information needed to recreate the object and its structure,  
   * the {@link Serializer} keeps track of the namespaces and classes in order to recreate {@link Serializable} objects. The general structure of a {@link Serialization} is as follows  
   * ```text
   * {
   *      namespaceName.className: {
   *          propertyName: propertyValue,
   *          ...,
   *          propertyNameOfReference: SerializationOfTheReferencedObject,
   *          ...,
   *          constructorNameOfSuperclass: SerializationOfSuperClass
   *      }
   * }
   * ```
   * Since the instance of the superclass is created automatically when an object is created, 
   * the SerializationOfSuperClass omits the the namespaceName.className key and consists only of its value. 
   * The constructorNameOfSuperclass is given instead as a property name in the serialization of the subclass.
   */
  export abstract class Serializer {
    /** In order for the Serializer to create class instances, it needs access to the appropriate namespaces */
    private static namespaces: NamespaceRegister = { "ƒ": FudgeCore };

    /**
     * Registers a namespace to the {@link Serializer}, to enable automatic instantiation of classes defined within
     */
    public static registerNamespace(_namespace: Object): string {
      for (let name in Serializer.namespaces)
        if (Serializer.namespaces[name] == _namespace)
          return name;

      let name: string = Serializer.findNamespaceIn(_namespace, window);
      if (!name)
        for (let parentName in Serializer.namespaces) {
          name = Serializer.findNamespaceIn(_namespace, Serializer.namespaces[parentName]);
          if (name) {
            name = parentName + "." + name;
            break;
          }
        }

      if (!name)
        throw new Error("Namespace not found. Maybe parent namespace hasn't been registered before?");

      Serializer.namespaces[name] = _namespace;
      return name;
    }


    /**
     * Returns a javascript object representing the serializable FUDGE-object given,
     * including attached components, children, superclass-objects all information needed for reconstruction
     * @param _object An object to serialize, implementing the {@link Serializable} interface
     */
    public static serialize(_object: Serializable): Serialization {
      let serialization: Serialization = {};
      // TODO: save the namespace with the constructors name
      // serialization[_object.constructor.name] = _object.serialize();
      let path: string = this.getFullPath(_object);
      if (!path)
        throw new Error(`Namespace of serializable object of type ${_object.constructor.name} not found. Maybe the namespace hasn't been registered or the class not exported?`);
      serialization[path] = _object.serialize();

      let serializables: Metadata["serializables"] = <Metadata["serializables"]>_object.constructor[Symbol.metadata]?.serializables;
      if (serializables) {
        for (const key in serializables) {
          let value: General = Reflect.get(_object, key);
          if (value == null)
            continue;

          switch (serializables[key]) {
            case "primitve":
              serialization[path][key] = value;
              break;
            case "resource":
              serialization[path][key] = value.idResource;
              break;
            case "nested":
              serialization[path][key] = value.serialize();
              break;
            case "node":
              serialization[path][key] = Node.PATH_FROM_TO(<Component>_object, value);
              break;
          }
        }
      }

      return serialization;
      // return _object.serialize();
    }

    /**
     * Returns a FUDGE-object reconstructed from the information in the {@link Serialization} given,
     * including attached components, children, superclass-objects
     */
    public static async deserialize(_serialization: Serialization): Promise<Serializable> {
      let reconstruct: Serializable;
      let path: string;
      try {
        // loop constructed solely to access type-property. Only one expected!
        for (path in _serialization) {
          reconstruct = Serializer.reconstruct(path);
          reconstruct = await reconstruct.deserialize(_serialization[path]);

          let serializables: Metadata["serializables"] = <Metadata["serializables"]>reconstruct.constructor[Symbol.metadata]?.serializables;
          if (serializables) {
            for (const key in serializables) {
              let value: General = _serialization[path][key];
              if (value == null)
                continue;

              switch (serializables[key]) {
                case "primitve":
                  Reflect.set(reconstruct, key, value);
                  break;
                case "resource":
                  Reflect.set(reconstruct, key, Project.resources[value] ?? await Project.getResource(value)); // await is costly so first try to get resource directly
                  break;
                case "nested":
                  await Reflect.get(reconstruct, key).deserialize(value);
                  break;
                case "node":
                  let instance: Component = <Component>reconstruct;
                  const hndNodeDeserialized: EventListenerUnified = () => {
                    const hndGraphDeserialized: EventListenerUnified = (_event: Event) => {
                      Reflect.set(reconstruct, key, Node.FIND(instance, value));
                      instance.node.removeEventListener(EVENT.GRAPH_DESERIALIZED, hndGraphDeserialized, true);
                      instance.node.removeEventListener(EVENT.GRAPH_INSTANTIATED, hndGraphDeserialized, true);
                      instance.removeEventListener(EVENT.NODE_DESERIALIZED, hndNodeDeserialized);
                    };
                    instance.node.addEventListener(EVENT.GRAPH_DESERIALIZED, hndGraphDeserialized, true);
                    instance.node.addEventListener(EVENT.GRAPH_INSTANTIATED, hndGraphDeserialized, true);
                  };
                  instance.addEventListener(EVENT.NODE_DESERIALIZED, hndNodeDeserialized);
              }
            }
          }

          return reconstruct;
        }
      } catch (_error) {
        let message: string = `Deserialization of ${path}, ${reconstruct ? Reflect.get(reconstruct, "idResource") : ""} failed: ` + _error;
        throw new Error(message);
      }
      return null;
    }

    /**
     * Returns an Array of javascript object representing the serializable FUDGE-objects given in the array,
     * including attached components, children, superclass-objects all information needed for reconstruction
     */
    public static serializeArray<T extends Serializable>(_type: new () => T, _objects: Serializable[]): Serialization {
      let serializations: Serialization[] = [];
      let path: string = this.getFullPath(new _type());
      if (!path)
        throw new Error(`Namespace of serializable object of type ${_type.name} not found. Maybe the namespace hasn't been registered or the class not exported?`);

      for (let object of _objects)
        serializations.push(object.serialize());

      let serialization: Serialization = {};
      serialization[path] = serializations;
      return serialization;
    }

    /**
     * Returns an Array of FUDGE-objects reconstructed from the information in the array of {@link Serialization}s given,
     * including attached components, children, superclass-objects
     */
    public static async deserializeArray(_serialization: Serialization): Promise<Serializable[]> {
      let serializables: Serializable[] = [];
      let construct: new () => Serializable;
      let serializations: Serialization[] = [];
      try {
        // loop constructed solely to access type-property. Only one expected!
        for (let path in _serialization) {
          construct = Serializer.getConstructor(path);
          serializations = _serialization[path];
          break;
        }
      } catch (_error) {
        throw new Error("Deserialization failed: " + _error);
      }

      for (let serialization of serializations) {
        let serializable: Serializable = new construct();
        await serializable.deserialize(serialization);
        serializables.push(serializable);
      }

      return serializables;
    }

    //TODO: implement prettifier to make JSON-Stringification of serializations more readable, e.g. placing x, y and z in one line
    /**
     * Prettify a JSON-String, to make it more readable.
     * not implemented yet
     */
    public static prettify(_json: string): string { return _json; }

    /**
     * Returns a formatted, human readable JSON-String, representing the given {@link Serialization} that may have been created by {@link Serializer}.serialize
     * @param _serialization
     */
    public static stringify(_serialization: Serialization): string {
      // adjustments to serialization can be made here before stringification, if desired
      let json: string = JSON.stringify(_serialization, null, 2);
      let pretty: string = Serializer.prettify(json);
      return pretty;
    }

    /**
     * Returns a {@link Serialization} created from the given JSON-String. Result may be passed to {@link Serializer.deserialize}
     * @param _json 
     */
    public static parse(_json: string): Serialization {
      return JSON.parse(_json);
    }

    /**
     * Creates an object of the class defined with the full path including the namespaceName(s) and the className seperated by dots(.) 
     * @param _path 
     */
    public static reconstruct(_path: string): Serializable {
      let constructor: new () => Serializable = Serializer.getConstructor(_path);
      let reconstruction: Serializable = new constructor();
      return reconstruction;
    }

    // public static getConstructor<T extends Serializable>(_type: string, _namespace: Object = FudgeCore): new () => T {
    /**
     * Returns the constructor from the given path to a class
     */
    public static getConstructor<T extends Serializable>(_path: string): new () => T {
      let typeName: string = _path.substring(_path.lastIndexOf(".") + 1);
      let namespace: Object = Serializer.getNamespace(_path);
      if (!namespace)
        throw new Error(`Constructor of serializable object of type ${_path} not found. Maybe the namespace hasn't been registered?`);
      return (<General>namespace)[typeName];
    }

    /**
     * Returns the full path to the class of the object, if found in the registered namespaces
     * @param _object 
     */
    private static getFullPath(_object: Serializable): string {
      let typeName: string = _object.constructor.name;
      // Debug.log("Searching namespace of: " + typeName);
      for (let namespaceName in Serializer.namespaces) {
        let found: General = (<General>Serializer.namespaces)[namespaceName][typeName];
        if (found && _object instanceof found)
          return namespaceName + "." + typeName;
      }
      return null;
    }

    /**
     * Returns the namespace-object defined within the full path, if registered
     * @param _path
     */
    private static getNamespace(_path: string): Object {
      let namespaceName: string = _path.substr(0, _path.lastIndexOf("."));
      return Serializer.namespaces[namespaceName] || FudgeCore;
    }

    /**
     * Finds the namespace-object in properties of the parent-object (e.g. window), if present
     * @param _namespace 
     * @param _parent 
     */
    private static findNamespaceIn(_namespace: Object, _parent: Object): string {
      for (let prop in _parent)
        if ((<General>_parent)[prop] == _namespace)
          return prop;
      return null;
    }
  }


  type Constructor<T> = abstract new (...args: General[]) => T;

  /**
   * Creates a new (abstract) class implementing {@link SerializableResourceExternal} from any class that implements {@link SerializableResource} by mixing in the functionality to load the resource from an external source.
   * @internal
   * @authors Jonas Plotzky, HFU, 2024
   */
  export function mixinSerializableResourceExternal<TBase extends Constructor<SerializableResource>>(_base: TBase) { /* eslint-disable-line */ //disable eslint because only type inference seems to be able to handle mixin abstract classes correctly
    abstract class SerializableResourceExternal extends _base implements FudgeCore.SerializableResourceExternal {
      public url: RequestInfo;

      public status: RESOURCE_STATUS = RESOURCE_STATUS.PENDING;

      /**
       * Returns a {@link Serialization} of this resource. Only the data needed to load it from the external source is serialized ("url", "name", "idResource").
       */
      public serialize(): Serialization {
        const serialization: Serialization = {
          idResource: this.idResource,
          name: this.name,
          type: this.type,
          url: this.url.toString()
        };
        return serialization;
      }

      public async deserialize(_serialization: Serialization): Promise<Serializable> {
        Project.register(this, _serialization.idResource);
        this.url = _serialization.url;
        this.name = _serialization.name;
        return this.load();
      }

      public abstract load(): Promise<SerializableResourceExternal>;
    };

    if (_base.prototype instanceof Mutable) {
      /**
       * Mixin the {@link Mutable} functionality into the class
       * @authors Jonas Plotzky, HFU, 2024
       */
      function mixinMutableSerializableResourceExternal<TBase extends Constructor<SerializableResourceExternal & Mutable>>(_base: TBase) { // eslint-disable-line
        abstract class MutableSerializableResourceExternal extends _base {
          public async mutate(_mutator: Mutator, _selection: string[] = null, _dispatchMutate: boolean = true): Promise<void> {
            await super.mutate(_mutator, _selection, false);
            if (_mutator.url != undefined || _mutator.name != undefined)
              await this.load();
          }

          protected reduceMutator(_mutator: Mutator): void {
            delete _mutator.status;
          }
        }

        return MutableSerializableResourceExternal;
      }

      return mixinMutableSerializableResourceExternal(<TBase & Constructor<SerializableResourceExternal & Mutable>>SerializableResourceExternal);
    }

    return SerializableResourceExternal;
  }
}