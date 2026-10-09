package nl.eigencloud.core;

import java.util.List;
import java.util.Map;

/** Json parse/stringify: unit checks and byte-identical output vs JSON.stringify(JSON.parse(x)) for the golden set. */
public class JsonTest {
    public static void main(String[] args) {
        T.main("JsonTest", () -> {
            // Unit checks
            T.eq("{\"a\":1,\"b\":[true,null,\"x\"]}", Json.stringify(Json.obj("a", 1, "b", Json.list(true, null, "x"))), "basic");
            T.eq("\"\\ud800\"", Json.stringify("\ud800"), "lone high surrogate escaped");
            T.eq("\"\\udc00\"", Json.stringify("\udc00"), "lone low surrogate escaped");
            T.eq("\"😀\"", Json.stringify("😀"), "pair kept");
            T.eq("\"/é\\u001f\\n\"", Json.stringify("/é\u001f\n"), "slash and non-ASCII not escaped");
            T.eq("4.51", Json.numberToString(4.51), "4.51");
            T.eq("0.5", Json.numberToString(0.5), "0.5");
            T.eq("1e+21", Json.numberToString(1e21), "1e21");
            T.eq("1e-7", Json.numberToString(1e-7), "1e-7");
            T.eq("0.000001", Json.numberToString(1e-6), "1e-6");
            T.eq("100", Json.numberToString(100.0), "100.0");
            T.eq("-0.1", Json.numberToString(-0.1), "-0.1");
            T.eq("null", Json.numberToString(Double.NaN), "NaN");
            T.eq(Long.valueOf(7), Json.parse("7"), "integers are Long");
            T.eq(Double.valueOf(7.5), Json.parse("7.5"), "fractions are Double");
            T.eq("{\n  \"a\": [\n    1\n  ],\n  \"b\": {}\n}", Json.stringify(Json.parse("{\"a\":[1],\"b\":{}}"), 2), "pretty");
            T.throwsWith("", () -> Json.parse("{\"a\":1,}"), "trailing comma refused");
            T.throwsWith("", () -> Json.parse("[1] x"), "trailing garbage refused");
            T.throwsWith("", () -> Json.parse("\"a\u0001\""), "raw control char refused");
            T.throwsWith("", () -> Json.parse("01"), "leading zero refused");
            T.eq("x", Json.str(Json.parse("{\"a\":[{\"b\":\"x\"}]}"), "a", 0, "b"), "path access");

            // Golden: JSON.stringify(JSON.parse(input)) from Node
            Map<String, Object> g = T.golden();
            for (Object o : (List<?>) g.get("json")) {
                String input = Json.str(o, "input");
                T.eq(Json.str(o, "expected"), Json.stringify(Json.parse(input)), "stringify(parse(" + Bytes.head(input, 40) + "))");
                T.eq(Json.str(o, "pretty"), Json.stringify(Json.parse(input), 2), "pretty(" + Bytes.head(input, 40) + ")");
            }
            // The whole golden file re-serializes identically (it was written with indent 1).
            T.eq(Json.stringify(g.get("sampleConfig")), Json.stringify(Json.parse(Json.stringify(g.get("sampleConfig")))), "round trip");
        });
    }
}
